/**
 * Opt-in RPC e2e. Run locally with `npm run test:e2e`; it is not part of `npm test` or CI.
 * Needs the `pi` CLI and a Pi agent dir with the `tailnet` provider (models.json / auth.json are copied from it).
 * System-1 is a local stub that returns scripted Gate probabilities.
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const EXECUTION = "tailnet/@preset/glm-flash";
const REASONING = "tailnet/@preset/glm-max";
const EXTENSION = resolve(import.meta.dirname, "../../src/index.ts");

let stub: Server;
let script: [number, number][] = [];
let pi: ChildProcessWithoutNullStreams;
const messages: any[] = [];
let onAgentEnd: (() => void) | undefined;

const gateAnswer = (d: number, e: number) => ({ answers: { role: { type: "choice", probabilities: { reasoning: d, execution: e } } } });

beforeAll(async () => {
	stub = createServer((req, res) => {
		req.resume();
		req.on("end", () => {
			const [d, e] = script.shift() ?? [0.5, 0.5];
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify(gateAnswer(d, e)));
		});
	});
	await new Promise<void>((r) => stub.listen(0, "127.0.0.1", r));
	const baseUrl = `http://127.0.0.1:${(stub.address() as AddressInfo).port}/api/v1/systemone`;

	const realDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	const agentDir = mkdtempSync(join(tmpdir(), "dm-e2e-"));
	for (const f of ["models.json", "auth.json"]) if (existsSync(join(realDir, f))) copyFileSync(join(realDir, f), join(agentDir, f));
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({ dualModels: { deliberationModel: REASONING, executionModel: EXECUTION, system1: { baseUrl } } }),
	);

	pi = spawn("pi", ["--mode", "rpc", "--no-session", "-e", EXTENSION, "--model", "dual-models/auto"], {
		env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, OPENROUTER_API_KEY: "stub" },
	});
	let buf = "";
	pi.stdout.on("data", (chunk) => {
		buf += chunk;
		for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
			const line = buf.slice(0, nl);
			buf = buf.slice(nl + 1);
			try {
				const event = JSON.parse(line);
				// Upstream presets sometimes 400 and Pi retries, so an errored message is not a served turn.
				if (event.type === "message_end" && event.message?.role === "assistant" && event.message.stopReason !== "error") messages.push(event.message);
				if (event.type === "agent_end") onAgentEnd?.();
			} catch {}
		}
	});
});

afterAll(() => {
	pi?.kill();
	stub?.close();
});

function prompt(text: string): Promise<void> {
	const served = messages.length;
	return new Promise((done, fail) => {
		const timer = setTimeout(() => fail(new Error("no served turn within 120 s")), 120_000);
		onAgentEnd = () => {
			if (messages.length === served) return;
			clearTimeout(timer);
			done();
		};
		pi.stdin.write(`${JSON.stringify({ type: "prompt", message: text })}\n`);
	});
}

const physical = (m: any) => `${m.provider}/${m.model}`;

describe("Dual Models over Pi RPC", () => {
	it("serves each turn on the scripted role and reuses the cache on returning to a role", async () => {
		const padding = "The quick brown fox jumps over the lazy dog. ".repeat(900);
		script = [
			[0.1, 0.9], // first prompt: argmax -> execution
			[0.95, 0.05], // P(reasoning) >= theta_switch -> reasoning
			[0.05, 0.95], // P(execution) >= theta_switch -> execution
		];
		await prompt(`${padding}\nReply with the single word: ok`);
		await prompt("Reply with the single word: ok");
		await prompt("Reply with the single word: ok");

		expect(messages.map(physical)).toEqual([EXECUTION, REASONING, EXECUTION]);
		expect(messages[2].usage.cacheRead).toBeGreaterThan(0);
	}, 360_000);
});
