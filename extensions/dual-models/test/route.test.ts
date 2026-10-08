import type { ExtensionContext, ModelRouteReason, ModelRouteRequest } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveConfig } from "../src/config.ts";
import { createRouter } from "../src/route.ts";

const physical = (provider: string, id: string) => ({ provider, id, api: "openai-completions" }) as never;
const DELIB = physical("kimi", "k3");
const EXEC = physical("zai", "glm-5.3-flash");

const ctx = {
	ui: { notify: () => {} },
	sessionManager: { getSessionId: () => "sess-1" },
	modelRegistry: {
		find: (provider: string, id: string) => [DELIB, EXEC].find((m: any) => m.provider === provider && m.id === id),
	},
} as unknown as ExtensionContext;

const request = (reason: ModelRouteReason): ModelRouteRequest =>
	({ model: physical("dual-models", "auto"), thinkingLevel: "medium", reason, messages: [] }) as never;

function router(extra: Record<string, unknown> = {}) {
	const result = resolveConfig({ dualModels: { deliberationModel: "kimi/k3", executionModel: "zai/glm-5.3-flash", ...extra } });
	return createRouter(() => result, () => ({ state: "", tokens: 0 }));
}

describe("route()", () => {
	beforeEach(() => vi.stubEnv("OPENROUTER_API_KEY", ""));
	afterEach(() => vi.unstubAllEnvs());

	for (const reason of ["user", "continuation", "retry"] as const) {
		it(`returns the deliberation model (default defaultRole) for ${reason}`, async () => {
			const route = await router()(request(reason), ctx);
			expect(route.model).toBe(DELIB);
			expect(route.thinkingLevel).toBe("medium");
		});

		it(`returns the execution model when defaultRole is execution for ${reason}`, async () => {
			const route = await router({ defaultRole: "execution" })(request(reason), ctx);
			expect(route.model).toBe(EXEC);
		});
	}

	it("serves a direct request with the execution model whatever defaultRole is", async () => {
		expect((await router()(request("direct"), ctx)).model).toBe(EXEC);
	});

	it("returns nothing but model and thinkingLevel, so prompt and tools stay identical across roles", async () => {
		const a = await router()(request("user"), ctx);
		const b = await router({ defaultRole: "execution" })(request("user"), ctx);
		expect(Object.keys(a).sort()).toEqual(["model", "thinkingLevel"]);
		expect(Object.keys(b).sort()).toEqual(["model", "thinkingLevel"]);
	});

	it("throws the validation errors when config is invalid", async () => {
		const bad = createRouter(() => resolveConfig({}), () => ({ state: "", tokens: 0 }));
		await expect(bad(request("user"), ctx)).rejects.toThrow(/dualModels/);
	});

	it("throws a clear error when the configured model is not in the catalog", async () => {
		const missing = createRouter(() => resolveConfig({ dualModels: { deliberationModel: "nope/x", executionModel: "zai/glm-5.3-flash" } }), () => ({ state: "", tokens: 0 }));
		await expect(missing(request("user"), ctx)).rejects.toThrow(/nope\/x/);
	});
});
