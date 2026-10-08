/**
 * Live experiment for #64: System-1 latency, cache reuse on role return, and the Gate's theta_switch.
 *
 *   cd extensions/dual-models && node docs/experiments/run-experiment.ts [latency] [cache] [live]
 *
 * Needs `pi` on PATH, OPENROUTER_API_KEY in the environment (never printed), and the `tailnet` provider in the
 * Pi agent dir (models.json / auth.json are copied into a throwaway agent dir). Spans are collected by a local
 * OTLP/HTTP-JSON receiver, so SigNoz is not needed. Writes results.json next to this file.
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { decide } from "../../src/system1.ts";

const EXECUTION = "tailnet/@preset/glm-flash";
const DELIBERATION = "tailnet/@preset/glm-max";
const SYSTEM1 = { model: "typesafe/jev-1.13", baseUrl: "https://openrouter.ai/api/v1/systemone" };
const EXTENSION = resolve(import.meta.dirname, "../../src/index.ts");
const HERE = import.meta.dirname;
const args = process.argv.slice(2);
const phases = new Set(args.length ? args : ["latency", "cache", "live"]);

const tmpDirs: string[] = [];
const mk = (prefix: string) => {
	const d = mkdtempSync(join(tmpdir(), prefix));
	tmpDirs.push(d);
	return d;
};

const pct = (xs: number[], p: number) => {
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const stats = (xs: number[]) => ({ n: xs.length, min: Math.min(...xs), p50: pct(xs, 50), p90: pct(xs, 90), max: Math.max(...xs) });

// ---- local OTLP/HTTP JSON receiver ----
interface GateSpan {
	durationMs: number;
	attrs: Record<string, string | number | boolean | undefined>;
	error: boolean;
}
const gateSpans: GateSpan[] = [];
const otlp: Server = createServer((req, res) => {
	const chunks: Buffer[] = [];
	req.on("data", (c) => chunks.push(c));
	req.on("end", () => {
		try {
			const body = JSON.parse(Buffer.concat(chunks).toString());
			for (const rs of body.resourceSpans ?? []) {
				const service = rs.resource?.attributes?.find((a: any) => a.key === "service.name")?.value?.stringValue;
				for (const ss of rs.scopeSpans ?? []) {
					for (const sp of ss.spans ?? []) {
						if (sp.name !== "dual_models.gate") continue;
						const attrs: GateSpan["attrs"] = { "service.name": service };
						for (const a of sp.attributes ?? []) {
							const v = a.value;
							attrs[a.key] = v.stringValue ?? (v.intValue !== undefined ? Number(v.intValue) : (v.doubleValue ?? v.boolValue));
						}
						const us = Number((BigInt(sp.endTimeUnixNano) - BigInt(sp.startTimeUnixNano)) / 1000n);
						gateSpans.push({ durationMs: us / 1000, attrs, error: sp.status?.code === 2 });
					}
				}
			}
		} catch {}
		res.writeHead(200, { "content-type": "application/json" }).end("{}");
	});
});

// ---- Pi RPC client ----
interface Turn {
	physical: string;
	stopReason: string;
	usage: any;
	err?: string;
}
class PiSession {
	proc: ChildProcessWithoutNullStreams;
	turns: Turn[] = [];
	private onEnd?: () => void;
	constructor(agentDir: string, cwd: string, env: Record<string, string>) {
		this.proc = spawn("pi", ["--mode", "rpc", "--no-session", "-e", EXTENSION, "--model", "dual-models/auto"], {
			cwd,
			env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, ...env },
		});
		let buf = "";
		this.proc.stdout.on("data", (chunk) => {
			buf += chunk;
			for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
				const line = buf.slice(0, nl);
				buf = buf.slice(nl + 1);
				try {
					const ev = JSON.parse(line);
					if (ev.type === "message_end" && ev.message?.role === "assistant") {
						const m = ev.message;
						this.turns.push({ physical: `${m.provider}/${m.model}`, stopReason: m.stopReason, usage: m.usage, err: m.errorMessage?.slice(0, 160) });
					}
					if (ev.type === "agent_end") this.onEnd?.();
				} catch {}
			}
		});
	}
	prompt(text: string, timeoutMs = 240_000): Promise<Turn[]> {
		const from = this.turns.length;
		return new Promise((done, fail) => {
			const t = setTimeout(() => fail(new Error("agent_end timeout")), timeoutMs);
			this.onEnd = () => {
				clearTimeout(t);
				done(this.turns.slice(from));
			};
			this.proc.stdin.write(`${JSON.stringify({ type: "prompt", message: text })}\n`);
		});
	}
	kill() {
		this.proc.kill();
	}
}

function agentDir(system1: Record<string, unknown>) {
	const real = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	const dir = mk("dm-exp-");
	for (const f of ["models.json", "auth.json"]) if (existsSync(join(real, f))) copyFileSync(join(real, f), join(dir, f));
	writeFileSync(join(dir, "settings.json"), JSON.stringify({ dualModels: { deliberationModel: DELIBERATION, executionModel: EXECUTION, system1 } }));
	return dir;
}

const otelEnv = () => ({
	OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${(otlp.address() as AddressInfo).port}`,
	OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
	OTEL_SERVICE_NAME: "pi",
});
const slim = (t: Turn) => ({ err: t.err, model: t.physical, stop: t.stopReason, input: t.usage?.input, cacheRead: t.usage?.cacheRead, cacheWrite: t.usage?.cacheWrite, output: t.usage?.output });
const results: Record<string, unknown> = {};

// ---- Phase A: System-1 latency, ~20-token vs ~4k-token Digest ----
async function latency() {
	const para =
		"The user asked to refactor the billing module. The assistant read src/billing/invoice.ts, ran the test suite, saw two failures in tax rounding, and edited calculateTax to use integer cents. Tool output: 38 passed, 2 failed. ";
	const digest4k = `Recap:\n${para.repeat(90)}`.slice(0, 16_000) + "\n\nNew prompt:\nNow also update the changelog.";
	const small = "New prompt:\nNow also update the changelog.";
	const out: Record<string, unknown> = {};
	for (const [name, digest] of [["digest_20tok", small], ["digest_4k", digest4k]] as const) {
		const ms: number[] = [];
		let failures = 0;
		await decide(digest, { ...SYSTEM1, timeoutMs: 10_000 }); // warm the connection
		for (let i = 0; i < 30; i++) {
			const t0 = performance.now();
			const r = await decide(digest, { ...SYSTEM1, timeoutMs: 10_000 });
			const dt = performance.now() - t0;
			if (r.ok) ms.push(Math.round(dt));
			else failures++;
		}
		out[name] = { chars: digest.length, approxTokens: Math.round(digest.length / 4), ...stats(ms), failures, over1500ms: ms.filter((x) => x > 1500).length };
	}
	results.latency = out;
}

// ---- Phase B: cache reuse across flash -> max -> flash -> max -> flash (scripted System-1) ----
const stubCalls: [number, number][] = [];
async function cache() {
	const script: [number, number][] = [[0.1, 0.9], [0.95, 0.05], [0.05, 0.95], [0.95, 0.05], [0.05, 0.95]];
	const stub = createServer((req, res) => {
		req.resume();
		req.on("end", () => {
			const [d, e] = script.shift() ?? [0.5, 0.5];
			stubCalls.push([d, e]);
			res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ answers: { role: { type: "choice", probabilities: { deliberation: d, execution: e } } } }));
		});
	});
	await new Promise<void>((r) => stub.listen(0, "127.0.0.1", r));
	const dir = agentDir({ baseUrl: `http://127.0.0.1:${(stub.address() as AddressInfo).port}/api/v1/systemone` });
	const cwd = mk("dm-exp-cwd-");
	const pi = new PiSession(dir, cwd, { OPENROUTER_API_KEY: "stub" });
	try {
		const padding = `[run ${randomUUID()}] ` + "The quick brown fox jumps over the lazy dog. ".repeat(900);
		const rows: ReturnType<typeof slim>[] = [];
		const ok = "Reply with the single word: ok";
		for (const p of [`${padding}\n${ok}`, ok, ok, ok, ok]) {
			const turns = await pi.prompt(p);
			rows.push(...turns.map(slim));
		}
		results.cache = { stubCalls, expectedRoles: ["execution", "deliberation", "execution", "deliberation", "execution"], rows };
	} finally {
		pi.kill();
		stub.close();
	}
}

// ---- Phase C: live Gate, real System-1, real models ----
async function live() {
	const dir = agentDir({ ...SYSTEM1 });
	const cwd = mk("dm-exp-cwd-");
	writeFileSync(join(cwd, "util.js"), "export function add(a, b) {\n  return a - b;\n}\n");
	writeFileSync(join(cwd, "util.test.js"), "import { add } from './util.js';\nif (add(2, 3) !== 5) { console.error('FAIL add(2,3) expected 5 got', add(2, 3)); process.exit(1); }\nconsole.log('ok');\n");
	writeFileSync(join(cwd, "package.json"), '{"type":"module"}\n');
	const scenarios: [string, string][] = [
		["trivial", "Reply with the single word: ready"],
		["trivial", "What is 17 * 3? Answer with just the number."],
		["ambiguous", "I want to make this project better but I am not sure what direction to take. Ask me what matters before doing anything."],
		["trivial", "Reply with the single word: done"],
		["escalation", "Run `node util.test.js` and tell me why it fails and what the right fix is. Do not edit anything yet."],
		["ambiguous", "Should we keep util.js as a single file or restructure into a package with a public API? Weigh the trade-offs."],
		["trivial", "Now apply the fix to util.js, then rerun `node util.test.js` to confirm."],
		["trivial", "Reply with the single word: finished"],
	];
	const pi = new PiSession(dir, cwd, otelEnv());
	const rows: unknown[] = [];
	const t0 = Date.now();
	try {
		for (const [kind, text] of scenarios) {
			const turns = await pi.prompt(text);
			rows.push({ kind, prompt: text.slice(0, 60), turns: turns.map(slim) });
		}
		await new Promise((r) => setTimeout(r, 8000)); // BatchSpanProcessor flush
	} finally {
		pi.kill();
	}
	results.live = { sessionMs: Date.now() - t0, rows, gateSpans };
}

await new Promise<void>((r) => otlp.listen(0, "127.0.0.1", r));
try {
	if (phases.has("latency")) await latency();
	if (phases.has("cache")) await cache();
	if (phases.has("live")) await live();
} finally {
	otlp.close();
	for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
	writeFileSync(join(HERE, `results-${[...phases].join("-")}.json`), JSON.stringify(results, null, 1));
}
console.log(JSON.stringify(results, null, 1));
