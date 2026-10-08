import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { ExtensionContext, ModelRouteReason, ModelRouteRequest } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveConfig } from "../src/config.ts";
import { createRouter } from "../src/route.ts";

const physical = (provider: string, id: string) => ({ provider, id, api: "openai-completions" }) as never;
const DELIB = physical("kimi", "k3");
const EXEC = physical("zai", "glm-5.3-flash");

interface Seen {
	auth?: string;
	url?: string;
	body: any;
}
let server: Server;
let baseUrl: string;
let seen: Seen[];
let digestText = "fix the failing test";
let respond: (res: ServerResponse) => void;

const json = (status: number, body: unknown) => (res: ServerResponse) => {
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify(body));
};
const answer = (pReasoning: number, pExecution: number) =>
	json(200, {
		answers: {
			role: {
				type: "choice",
				choice: pReasoning >= pExecution ? "reasoning" : "execution",
				probabilities: { reasoning: pReasoning, execution: pExecution },
				confidence: 0.9,
			},
		},
		usage: { input_tokens: 1, output_tokens: 1, cost: 0 },
		model: "typesafe/jev-1.13-20260917",
		provider: "x",
	});

beforeEach(async () => {
	seen = [];
	digestText = "fix the failing test";
	respond = answer(0.1, 0.9);
	server = createServer((req: IncomingMessage, res) => {
		let data = "";
		req.on("data", (c) => (data += c));
		req.on("end", () => {
			seen.push({ auth: req.headers.authorization, url: req.url, body: JSON.parse(data || "null") });
			respond(res);
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
	sessionManager: { getSessionId: () => "sess-1" },
	modelRegistry: { find: (p: string, id: string) => [DELIB, EXEC].find((m: any) => m.provider === p && m.id === id) },
} as unknown as ExtensionContext;

const request = (reason: ModelRouteReason, prompt = "fix the failing test"): ModelRouteRequest =>
	({
		model: physical("dual-models", "auto"),
		thinkingLevel: "medium",
		reason,
		messages: [
			{ role: "system", content: "sys" },
			{ role: "user", content: [{ type: "text", text: prompt }] },
		],
	}) as never;

function router(extra: Record<string, unknown> = {}, system1: Record<string, unknown> = {}) {
	const result = resolveConfig({
		dualModels: { deliberationModel: "kimi/k3", executionModel: "zai/glm-5.3-flash", system1: { baseUrl, ...system1 }, ...extra },
	});
	return createRouter(() => result, () => ({ state: digestText, tokens: 1 }));
}

describe("System-1 Gate on new prompts", () => {
	beforeEach(() => notify.mockClear());

	it("calls System-1 on a user reason and returns the argmax role's model", async () => {
		const r = router();
		expect((await r(request("user"), ctx)).model).toBe(EXEC);
		respond = answer(0.8, 0.2);
		expect((await r(request("user"), ctx)).model).toBe(DELIB);
		expect(seen).toHaveLength(2);
	});

	it("sends a bearer key and {model, state, questions} with a record-keyed choice Gate", async () => {
		digestText = "Intent: hello there";
		await router()(request("user"), ctx);
		const { auth, body, url } = seen[0];
		expect(url).toBe("/api/v1/systemone");
		expect(auth).toBe("Bearer sk-test");
		expect(body.model).toBe("typesafe/jev-1.13");
		expect(body.state).toContain("hello there");
		expect(Array.isArray(body.questions)).toBe(false);
		const q = body.questions.role;
		expect(q.type).toBe("choice");
		expect(Object.keys(q.criteria).sort()).toEqual(["execution", "reasoning"]);
	});

	it("sends the new prompt to System-1 even when the Recap is empty, truncated head and tail", async () => {
		digestText = "Intent: (not set)\nCourse of action: (not set)";
		await router({ digest: { toolOutputTokens: 50 } })(request("user", "PROMPT-START add a retry to the uploader"), ctx);
		const state: string = seen[0].body.state;
		expect(state).toContain("Intent: (not set)");
		expect(state).toContain("New prompt:\nPROMPT-START add a retry");
		seen.length = 0;
		await router({ digest: { toolOutputTokens: 50 } })(request("user", `HEAD-MARK ${"x".repeat(5000)} TAIL-MARK`), ctx);
		const big: string = seen[0].body.state;
		expect(big).toMatch(/HEAD-MARK[\s\S]*truncated[\s\S]*TAIL-MARK/);
		expect(big.length).toBeLessThan(600);
	});

	it("never mentions the current role in the Gate wording or state", async () => {
		const req = { ...request("user"), previous: { model: DELIB } } as ModelRouteRequest;
		await router()(req, ctx);
		const q = JSON.stringify(seen[0].body.questions).toLowerCase();
		expect(q).not.toMatch(/current|previous|switch/);
		expect(seen[0].body.state).not.toContain("kimi");
	});

	it("does not call System-1 for retry or direct reasons", async () => {
		const r = router();
		expect((await r(request("retry"), ctx)).model).toBe(DELIB);
		expect((await r(request("direct"), ctx)).model).toBe(EXEC);
		expect(seen).toHaveLength(0);
	});

	it("forceReasoningOnPrompt returns the reasoning model without a call", async () => {
		const route = await router({ forceReasoningOnPrompt: true, defaultRole: "execution" })(request("user"), ctx);
		expect(route.model).toBe(DELIB);
		expect(seen).toHaveLength(0);
	});

	it("missing key falls back to defaultRole without a call and without a notice until the Gate disables", async () => {
		vi.stubEnv("OPENROUTER_API_KEY", "");
		const r = router({ defaultRole: "execution" });
		expect((await r(request("user"), ctx)).model).toBe(EXEC);
		expect(seen).toHaveLength(0);
		expect(notify).not.toHaveBeenCalled();
	});

	it("HTTP error falls back to defaultRole", async () => {
		respond = json(500, { error: "boom" });
		expect((await router()(request("user"), ctx)).model).toBe(DELIB);
		expect(seen).toHaveLength(1);
	});

	it("malformed response falls back to defaultRole", async () => {
		respond = json(200, { answers: {} });
		expect((await router({ defaultRole: "execution" })(request("user"), ctx)).model).toBe(EXEC);
	});

	it("timeout falls back to defaultRole", async () => {
		respond = () => {};
		const route = await router({ defaultRole: "execution" }, { timeoutMs: 50 })(request("user"), ctx);
		expect(route.model).toBe(EXEC);
	});

	it("disables the Gate after 3 consecutive failures and shows a notice", async () => {
		respond = json(500, {});
		const r = router();
		for (let i = 0; i < 3; i++) await r(request("user"), ctx);
		expect(seen).toHaveLength(3);
		expect(notify).toHaveBeenLastCalledWith(expect.stringMatching(/disabled/i), "warning");
		respond = answer(0.1, 0.9);
		expect((await r(request("user"), ctx)).model).toBe(DELIB);
		expect(seen).toHaveLength(3);
	});

	it("reset() re-enables the Gate after it was disabled", async () => {
		respond = json(500, {});
		const r = router();
		for (let i = 0; i < 3; i++) await r(request("user"), ctx);
		await r(request("user"), ctx);
		expect(seen).toHaveLength(3);
		r.reset();
		respond = answer(0.9, 0.1);
		expect((await r(request("user"), ctx)).model).toBe(DELIB);
		expect(seen).toHaveLength(4);
	});

	it("a success resets the consecutive failure count", async () => {
		const r = router();
		respond = json(500, {});
		await r(request("user"), ctx);
		await r(request("user"), ctx);
		respond = answer(0.1, 0.9);
		await r(request("user"), ctx);
		respond = json(500, {});
		await r(request("user"), ctx);
		await r(request("user"), ctx);
		respond = answer(0.1, 0.9);
		expect((await r(request("user"), ctx)).model).toBe(EXEC);
		expect(seen).toHaveLength(6);
	});
});
