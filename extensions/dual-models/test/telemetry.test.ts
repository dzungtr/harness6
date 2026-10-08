import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import type { ExtensionContext, ModelRouteRequest } from "@earendil-works/pi-coding-agent";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveConfig } from "../src/config.ts";
import { DEFAULT_CRITERIA } from "../src/system1.ts";
import { createRouter } from "../src/route.ts";

const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });

const DELIB = { provider: "kimi", id: "k3" } as never;
const EXEC = { provider: "zai", id: "glm-5.3-flash" } as never;
const ctx = {
	ui: { notify: vi.fn() },
	sessionManager: { getSessionId: () => "sess-42" },
	modelRegistry: { find: (p: string, id: string) => [DELIB, EXEC].find((m: any) => m.provider === p && m.id === id) },
} as unknown as ExtensionContext;
const request = { reason: "user", thinkingLevel: "medium", messages: [{ role: "user", content: "do it" }] } as unknown as ModelRouteRequest;

let server: Server;
let respond: (res: import("node:http").ServerResponse) => void;
let baseUrl: string;

beforeAll(async () => {
	expect(trace.setGlobalTracerProvider(provider)).toBe(true);
	server = createServer((_req, res) => respond(res));
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
});
afterAll(async () => {
	server.closeAllConnections();
	await new Promise((r) => server.close(r));
});
beforeEach(() => {
	exporter.reset();
	vi.stubEnv("OPENROUTER_API_KEY", "sk-test");
});
afterEach(() => vi.unstubAllEnvs());

const answer = (d: number, e: number) => (res: import("node:http").ServerResponse) => {
	res.writeHead(200, { "content-type": "application/json" });
	res.end(JSON.stringify({ answers: { role: { probabilities: { reasoning: d, execution: e } } } }));
};

function router(system1: Record<string, unknown> = {}, criteria: Record<string, string> = {}) {
	const result = resolveConfig({
		dualModels: { models: { reasoning: { model: "kimi/k3", criteria: criteria.reasoning }, execution: { model: "zai/glm-5.3-flash", criteria: criteria.execution } }, system1: { baseUrl, ...system1 } },
	});
	return createRouter(() => result, () => ({ state: "Intent: x", tokens: 7 }));
}

describe("dual_models.gate span", () => {
	it("hashes the effective criteria and never exports criteria text", async () => {
		respond = answer(0.2, 0.8);
		await router({}, { execution: "SECRET-CRITERIA-TEXT" })(request, ctx);
		const attrs = exporter.getFinishedSpans()[0].attributes;
		expect(attrs["gate.criteria_hash"]).toMatch(/^[0-9a-f]{12}$/);
		expect(JSON.stringify(attrs)).not.toContain("SECRET-CRITERIA-TEXT");
		for (const v of Object.values(attrs)) expect(String(v)).not.toContain(DEFAULT_CRITERIA.reasoning);
	});

	it("emits one span per Gate call with every attribute, on the existing global provider", async () => {
		respond = answer(0.2, 0.8);
		await router()(request, ctx);
		const spans = exporter.getFinishedSpans();
		expect(spans).toHaveLength(1);
		expect(spans[0].name).toBe("dual_models.gate");
		expect(spans[0].attributes).toEqual({
			event: "prompt",
			"system1.model": "typesafe/jev-1.13",
			"p.reasoning": 0.2,
			"p.execution": 0.8,
			"role.chosen": "execution",
			"role.previous": "none",
			switched: false,
			fallback: false,
			"digest.tokens": 7,
			"session.id": "sess-42",
			"gen_ai.conversation.id": "sess-42",
			"gate.criteria_hash": expect.stringMatching(/^[0-9a-f]{12}$/),
		});
		expect(spans[0].status.code).not.toBe(SpanStatusCode.ERROR);
	});

	it("records the previous role and whether the Gate switched", async () => {
		respond = answer(0.9, 0.1);
		await router()({ ...request, previous: { model: EXEC } } as ModelRouteRequest, ctx);
		const attrs = exporter.getFinishedSpans()[0].attributes;
		expect(attrs["role.previous"]).toBe("execution");
		expect(attrs["role.chosen"]).toBe("reasoning");
		expect(attrs.switched).toBe(true);
	});

	it("labels a turn-end Gate call with the turn_end event", async () => {
		respond = answer(0.9, 0.1);
		await router()({ ...request, reason: "continuation", previous: { model: EXEC } } as ModelRouteRequest, ctx);
		const attrs = exporter.getFinishedSpans()[0].attributes;
		expect(attrs.event).toBe("turn_end");
		expect(attrs.switched).toBe(true);
	});

	it("reports switched=false when argmax matches the previous role", async () => {
		respond = answer(0.3, 0.7);
		await router()({ ...request, reason: "continuation", previous: { model: EXEC } } as ModelRouteRequest, ctx);
		const attrs = exporter.getFinishedSpans()[0].attributes;
		expect(attrs["role.previous"]).toBe("execution");
		expect(attrs["role.chosen"]).toBe("execution");
		expect(attrs.switched).toBe(false);
	});

	it("counts the tokens of the Digest actually sent, including the new prompt", async () => {
		respond = answer(0.2, 0.8);
		await router()({ ...request, messages: [{ role: "user", content: "p".repeat(400) }] } as unknown as ModelRouteRequest, ctx);
		expect(exporter.getFinishedSpans()[0].attributes["digest.tokens"]).toBeGreaterThan(100);
	});

	it("span duration covers the System-1 round-trip", async () => {
		respond = (res) => setTimeout(() => answer(0.5, 0.5)(res), 80);
		await router()(request, ctx);
		const [s] = exporter.getFinishedSpans();
		const ms = (s.endTime[0] - s.startTime[0]) * 1000 + (s.endTime[1] - s.startTime[1]) / 1e6;
		expect(ms).toBeGreaterThanOrEqual(75);
	});

	it("marks fallback=true with an error status when System-1 fails", async () => {
		respond = (res) => (res.writeHead(500), res.end());
		await router()(request, ctx);
		const [s] = exporter.getFinishedSpans();
		expect(s.attributes.fallback).toBe(true);
		expect(s.attributes["role.chosen"]).toBe("reasoning");
		expect(s.attributes["p.reasoning"]).toBeUndefined();
		expect(s.status.code).toBe(SpanStatusCode.ERROR);
	});

	it("emits no span when the Gate is not consulted", async () => {
		await router()({ ...request, reason: "retry" } as ModelRouteRequest, ctx);
		expect(exporter.getFinishedSpans()).toHaveLength(0);
	});
});
