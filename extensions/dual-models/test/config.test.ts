import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, resolveConfig } from "../src/config.ts";

const models = { deliberationModel: "kimi/k3", executionModel: "zai/glm-5.3-flash" };

describe("resolveConfig", () => {
	it("applies #58 defaults when only the two models are set", () => {
		const result = resolveConfig({ dualModels: models });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.config).toEqual({
			...models,
			system1: {
				model: "typesafe/jev-1.13",
				baseUrl: "https://openrouter.ai/api/v1/systemone",
				timeoutMs: 1500,
				thetaSwitch: DEFAULT_CONFIG.system1.thetaSwitch,
			},
			digest: { recapTokens: 2000, toolOutputTokens: 2000 },
			events: {
				prompt: "system1",
				turn_end: "system1",
				retry: "previous",
				compaction: "execution",
				"side-call": "execution",
			},
			defaultRole: "deliberation",
			forceDeliberationOnPrompt: false,
		});
		expect(DEFAULT_CONFIG.system1.thetaSwitch).toBeGreaterThan(0.5);
	});

	it("merges a partial override over defaults", () => {
		const result = resolveConfig({
			dualModels: { ...models, system1: { thetaSwitch: 0.8, baseUrl: "http://127.0.0.1:9999/systemone" }, events: { retry: "execution" } },
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.config.system1).toMatchObject({ thetaSwitch: 0.8, baseUrl: "http://127.0.0.1:9999/systemone", timeoutMs: 1500 });
		expect(result.config.events.retry).toBe("execution");
		expect(result.config.events.prompt).toBe("system1");
	});

	it("lets the project override win over user scope per key", () => {
		const result = resolveConfig({ dualModels: models }, { dualModels: { executionModel: "other/cheap", defaultRole: "execution" } });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.config.executionModel).toBe("other/cheap");
		expect(result.config.deliberationModel).toBe("kimi/k3");
		expect(result.config.defaultRole).toBe("execution");
	});

	it("reports a missing dualModels key", () => {
		const result = resolveConfig({});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.errors.join("\n")).toMatch(/dualModels/);
	});

	it("reports every invalid field with its path", () => {
		const result = resolveConfig({
			dualModels: {
				deliberationModel: "no-slash",
				executionModel: 5,
				system1: { timeoutMs: -1, thetaSwitch: 0.4, baseUrl: "" },
				digest: { recapTokens: 0 },
				events: { prompt: "bogus", unknown: "system1" },
				defaultRole: "system1",
				forceDeliberationOnPrompt: "yes",
				extra: 1,
			},
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		const text = result.errors.join("\n");
		for (const path of [
			"dualModels.deliberationModel",
			"dualModels.executionModel",
			"dualModels.system1.timeoutMs",
			"dualModels.system1.thetaSwitch",
			"dualModels.system1.baseUrl",
			"dualModels.digest.recapTokens",
			"dualModels.events.prompt",
			"dualModels.events.unknown",
			"dualModels.defaultRole",
			"dualModels.forceDeliberationOnPrompt",
			"dualModels.extra",
		]) {
			expect(text).toContain(path);
		}
	});

	it("rejects thetaSwitch above 1", () => {
		const result = resolveConfig({ dualModels: { ...models, system1: { thetaSwitch: 1.5 } } });
		expect(result.ok).toBe(false);
	});

	it("rejects previous as defaultRole", () => {
		const result = resolveConfig({ dualModels: { ...models, defaultRole: "previous" } });
		expect(result.ok).toBe(false);
	});
});
