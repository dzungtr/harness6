import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext, ModelRouteReason, ModelRouteRequest } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveConfig } from "../src/config.ts";
import dualModels from "../src/index.ts";
import { createRouter } from "../src/route.ts";

const physical = (provider: string, id: string) => ({ provider, id, api: "openai-completions" }) as never;
const DELIB = physical("kimi", "k3");
const EXEC = physical("zai", "glm-5.3-flash");

let server: Server;
let baseUrl: string;
let bodies: any[];
let probs: [number, number];

beforeEach(async () => {
	bodies = [];
	probs = [0.5, 0.5];
	server = createServer((req: IncomingMessage, res: ServerResponse) => {
		let data = "";
		req.on("data", (c) => (data += c));
		req.on("end", () => {
			bodies.push(JSON.parse(data));
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ answers: { role: { type: "choice", probabilities: { reasoning: probs[0], execution: probs[1] } } } }));
		});
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/systemone`;
	vi.stubEnv("OPENROUTER_API_KEY", "sk-test");
});
afterEach(async () => {
	vi.unstubAllEnvs();
	server.closeAllConnections();
	await new Promise((r) => server.close(r));
});

const notify = vi.fn();
const ctx = {
	ui: { notify },
	sessionManager: { getSessionId: () => "s" },
	modelRegistry: { find: (p: string, id: string) => [DELIB, EXEC].find((m: any) => m.provider === p && m.id === id) },
} as unknown as ExtensionContext;

const request = (reason: ModelRouteReason, previous?: unknown, prompt = "do it"): ModelRouteRequest =>
	({
		model: physical("dual-models", "auto"),
		thinkingLevel: "medium",
		reason,
		previous: previous ? { model: previous } : undefined,
		messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
	}) as never;

function router(extra: Record<string, unknown> = {}, compacting = false) {
	const { system1, ...rest } = extra;
	const result = resolveConfig({
		dualModels: { deliberationModel: "kimi/k3", executionModel: "zai/glm-5.3-flash", system1: { baseUrl, ...(system1 as object) }, ...rest },
	});
	const digestCalls: unknown[] = [];
	const r = createRouter(
		() => result,
		(opts) => {
			digestCalls.push(opts);
			return { state: "Intent: x\n\nLast tool output:\nTOOL-OUT", tokens: 1 };
		},
		() => compacting,
	);
	return Object.assign(r, { digestCalls });
}

describe("turn-end Gate with theta_switch hysteresis (default theta 0.75)", () => {
	beforeEach(() => notify.mockClear());

	it("calls the Gate on continuation with the full Digest including the last tool output", async () => {
		const r = router();
		await r(request("continuation", EXEC), ctx);
		expect(bodies).toHaveLength(1);
		expect(bodies[0].state).toContain("TOOL-OUT");
		expect(r.digestCalls[0]).toBeUndefined();
	});

	it("stays on the current role when P(other) is below theta", async () => {
		probs = [0.74, 0.26];
		expect((await router()(request("continuation", EXEC), ctx)).model).toBe(EXEC);
		probs = [0.26, 0.74];
		expect((await router()(request("continuation", DELIB), ctx)).model).toBe(DELIB);
	});

	it("switches when P(other) is at or above theta", async () => {
		probs = [0.75, 0.25];
		expect((await router()(request("continuation", EXEC), ctx)).model).toBe(DELIB);
		probs = [0.1, 0.9];
		expect((await router()(request("continuation", DELIB), ctx)).model).toBe(EXEC);
	});

	it("honours a configured thetaSwitch", async () => {
		probs = [0.6, 0.4];
		expect((await router({ system1: { thetaSwitch: 0.6 } })(request("continuation", EXEC), ctx)).model).toBe(DELIB);
	});

	it("takes the argmax when there is no previous role", async () => {
		probs = [0.55, 0.45];
		expect((await router()(request("continuation"), ctx)).model).toBe(DELIB);
	});

	it("applies the same hysteresis to a new prompt after the first", async () => {
		probs = [0.7, 0.3];
		expect((await router()(request("user", EXEC), ctx)).model).toBe(EXEC);
		probs = [0.8, 0.2];
		expect((await router()(request("user", EXEC), ctx)).model).toBe(DELIB);
	});

	it("leaves the stale tool output out of the Digest for a new prompt", async () => {
		const r = router();
		await r(request("user", EXEC), ctx);
		expect(r.digestCalls[0]).toEqual({ toolOutput: false });
		expect(bodies[0].state).toContain("New prompt:");
	});

	it("falls back to defaultRole on failure, notifying only when the Gate disables", async () => {
		vi.stubEnv("OPENROUTER_API_KEY", "");
		const r = router({ defaultRole: "execution" });
		for (let i = 0; i < 2; i++) expect((await r(request("continuation", DELIB), ctx)).model).toBe(EXEC);
		expect(notify).not.toHaveBeenCalled();
		await r(request("continuation", DELIB), ctx);
		expect(notify).toHaveBeenCalledTimes(1);
		expect(notify).toHaveBeenCalledWith(expect.stringMatching(/disabled/i), "warning");
	});
});

describe("event map", () => {
	it("defaults: retry -> previous, compaction -> execution, direct -> execution, without a Gate call", async () => {
		const r = router({ defaultRole: "reasoning" });
		expect((await r(request("retry", DELIB), ctx)).model).toBe(DELIB);
		expect((await r(request("retry", EXEC), ctx)).model).toBe(EXEC);
		expect((await r(request("direct", DELIB), ctx)).model).toBe(EXEC);
		expect((await router({}, true)(request("direct", DELIB), ctx)).model).toBe(EXEC);
		expect(bodies).toHaveLength(0);
	});

	it("retry with no previous model uses defaultRole", async () => {
		expect((await router({ defaultRole: "execution" })(request("retry"), ctx)).model).toBe(EXEC);
	});

	it("tells a compaction summary call from a side call by the compaction flag", async () => {
		const events = { compaction: "reasoning", "side-call": "execution" };
		expect((await router({ events }, true)(request("direct", EXEC), ctx)).model).toBe(DELIB);
		expect((await router({ events }, false)(request("direct", DELIB), ctx)).model).toBe(EXEC);
	});

	it("overrides map each event to a role or previous; a fixed role skips the Gate", async () => {
		const events = { prompt: "execution", turn_end: "reasoning", retry: "execution", "side-call": "previous" };
		const r = router({ events });
		expect((await r(request("user", DELIB), ctx)).model).toBe(EXEC);
		expect((await r(request("continuation", EXEC), ctx)).model).toBe(DELIB);
		expect((await r(request("retry", DELIB), ctx)).model).toBe(EXEC);
		expect((await r(request("direct", DELIB), ctx)).model).toBe(DELIB);
		expect(bodies).toHaveLength(0);
	});

	it("a side-call mapped to system1 asks the Gate", async () => {
		probs = [0.9, 0.1];
		expect((await router({ events: { "side-call": "system1" } })(request("direct", EXEC), ctx)).model).toBe(DELIB);
		expect(bodies).toHaveLength(1);
	});

	it("a turn_end mapped to a fixed role is unaffected by a missing key", async () => {
		vi.stubEnv("OPENROUTER_API_KEY", "");
		expect((await router({ events: { turn_end: "execution" } })(request("continuation", DELIB), ctx)).model).toBe(EXEC);
	});
});

describe("cache rules", () => {
	it("returns only model and thinkingLevel on every switch, so system prompt and tools never change", async () => {
		probs = [0.9, 0.1];
		const r = router();
		const a = await r(request("continuation", EXEC), ctx);
		probs = [0.1, 0.9];
		const b = await r(request("continuation", DELIB), ctx);
		expect(a.model).not.toBe(b.model);
		expect(Object.keys(a).sort()).toEqual(["model", "thinkingLevel"]);
		expect(Object.keys(b).sort()).toEqual(["model", "thinkingLevel"]);
	});
});

describe("compaction flag wiring", () => {
	it("route() sees a compaction summary between session_before_compact and session_compact", async () => {
		const handlers: Record<string, ((...a: any[]) => unknown)[]> = {};
		let vm: any;
		dualModels({
			on: (n: string, h: any) => void (handlers[n] ??= []).push(h),
			registerVirtualModel: (m: unknown) => void (vm = m),
			registerTool: () => {},
			appendEntry: () => {},
		} as never);
		const full = { ...ctx, cwd: "/nonexistent", isProjectTrusted: () => false, sessionManager: { getBranch: () => [], getSessionId: () => "s" } } as any;
		const dir = mkdtempSync(join(tmpdir(), "dm-c-"));
		writeFileSync(
			join(dir, "settings.json"),
			JSON.stringify({ dualModels: { deliberationModel: "kimi/k3", executionModel: "zai/glm-5.3-flash", events: { compaction: "reasoning" } } }),
		);
		vi.stubEnv("PI_CODING_AGENT_DIR", dir);
		const fire = (n: string) => handlers[n]?.forEach((h) => h({ type: n }, full));
		fire("session_start");
		expect((await vm.route(request("direct", EXEC), full)).model).toBe(EXEC);
		fire("session_before_compact");
		expect((await vm.route(request("direct", EXEC), full)).model).toBe(DELIB);
		fire("session_compact");
		expect((await vm.route(request("direct", EXEC), full)).model).toBe(EXEC);
		fire("session_before_compact");
		fire("session_compact_failed");
		expect((await vm.route(request("direct", EXEC), full)).model).toBe(EXEC);
	});
});
