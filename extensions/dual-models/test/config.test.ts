import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { resolveConfig } from "../src/config.ts";
import { DEFAULT_CRITERIA } from "../src/system1.ts";

const models = { models: { reasoning: { model: "kimi/k3" }, execution: { model: "zai/glm-5.3-flash" } } };

describe("resolveConfig", () => {
	it("applies #58 defaults when only the two models are set", () => {
		const result = resolveConfig({ dualModels: models });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.config).toEqual({
			reasoningModel: "kimi/k3", executionModel: "zai/glm-5.3-flash",
			criteria: DEFAULT_CRITERIA,
			criteriaHash: createHash("sha256").update(JSON.stringify(DEFAULT_CRITERIA)).digest("hex").slice(0, 12),
			system1: {
				model: "typesafe/jev-1.13",
				baseUrl: "https://openrouter.ai/api/v1/systemone",
				timeoutMs: 1500,
			},
			digest: { recapTokens: 2000, toolOutputTokens: 2000 },
			events: {
				prompt: "system1",
				turn_end: "system1",
				retry: "previous",
				compaction: "execution",
				"side-call": "execution",
			},
			defaultRole: "reasoning",
			forceReasoningOnPrompt: false,
		});
	});

	it("merges a partial override over defaults", () => {
		const result = resolveConfig({
			dualModels: { ...models, system1: { timeoutMs: 800, baseUrl: "http://127.0.0.1:9999/systemone" }, events: { retry: "execution" } },
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.config.system1).toMatchObject({ timeoutMs: 800, baseUrl: "http://127.0.0.1:9999/systemone" });
		expect(result.config.events.retry).toBe("execution");
		expect(result.config.events.prompt).toBe("system1");
	});

	it("lets the project override win over user scope per key", () => {
		const result = resolveConfig({ dualModels: models }, { dualModels: { models: { execution: { model: "other/cheap" } }, defaultRole: "execution" } });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.config.executionModel).toBe("other/cheap");
		expect(result.config.reasoningModel).toBe("kimi/k3");
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
				models: { reasoning: { model: "no-slash", criteria: "" }, execution: { model: 5 }, extra: {} },
				system1: { timeoutMs: -1, baseUrl: "" },
				digest: { recapTokens: 0 },
				events: { prompt: "bogus", unknown: "system1" },
				defaultRole: "system1",
				forceReasoningOnPrompt: "yes",
				extra: 1,
			},
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		const text = result.errors.join("\n");
		for (const path of [
			"dualModels.models.reasoning.model",
			"dualModels.models.reasoning.criteria",
			"dualModels.models.execution.model",
			"dualModels.models.extra",
			"dualModels.system1.timeoutMs",
			"dualModels.system1.baseUrl",
			"dualModels.digest.recapTokens",
			"dualModels.events.prompt",
			"dualModels.events.unknown",
			"dualModels.defaultRole",
			"dualModels.forceReasoningOnPrompt",
			"dualModels.extra",
		]) {
			expect(text).toContain(path);
		}
	});

	it("hints the new key for forceDeliberationOnPrompt", () => {
		const result = resolveConfig({ dualModels: { ...models, forceDeliberationOnPrompt: true } });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.errors).toEqual(["dualModels.forceDeliberationOnPrompt: removed; use forceReasoningOnPrompt"]);
	});

	it('hints "reasoning" for defaultRole "deliberation"', () => {
		const result = resolveConfig({ dualModels: { ...models, defaultRole: "deliberation" } });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.errors).toEqual(['dualModels.defaultRole: removed value "deliberation"; use "reasoning"']);
	});

	it('hints "reasoning" for events target "deliberation"', () => {
		const result = resolveConfig({ dualModels: { ...models, events: { compaction: "deliberation" } } });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.errors).toEqual(['dualModels.events.compaction: removed value "deliberation"; use "reasoning"']);
	});

	it("names both required models when the config is missing", () => {
		const result = resolveConfig({});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.errors.join("\n")).toMatch(/models\.reasoning\.model[\s\S]*models\.execution\.model/);
	});

	it("gives each removed key a one-line migration hint", () => {
		const hint = (cfg: object) => {
			const r = resolveConfig({ dualModels: { ...models, ...cfg } });
			expect(r.ok).toBe(false);
			return r.ok ? [] : r.errors;
		};
		expect(hint({ deliberationModel: "a/b" })).toEqual(["dualModels.deliberationModel: removed; use models.reasoning.model"]);
		expect(hint({ executionModel: "a/b" })).toEqual(["dualModels.executionModel: removed; use models.execution.model"]);
		expect(hint({ system1: { thetaSwitch: 0.8 } })).toEqual([
			"dualModels.system1.thetaSwitch: removed; the Gate follows System-1's argmax. Tune with models.<role>.criteria",
		]);
	});

	it("rejects empty or non-string criteria", () => {
		for (const criteria of ["", "   ", 5]) {
			const r = resolveConfig({ dualModels: { models: { reasoning: { model: "kimi/k3", criteria }, execution: { model: "zai/x" } } } });
			expect(r.ok, String(criteria)).toBe(false);
			if (!r.ok) expect(r.errors.join()).toContain("dualModels.models.reasoning.criteria");
		}
	});

	it("overrides one role's criteria and keeps the default for the other", () => {
		const r = resolveConfig({ dualModels: { models: { reasoning: { model: "kimi/k3" }, execution: { model: "zai/x", criteria: "tiny edits" } } } });
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.config.criteria).toEqual({ reasoning: DEFAULT_CRITERIA.reasoning, execution: "tiny edits" });
		expect(Object.keys(r.config.criteria)).toEqual(["reasoning", "execution"]);
		const base = resolveConfig({ dualModels: models });
		if (base.ok) expect(r.config.criteriaHash).not.toBe(base.config.criteriaHash);
	});

	it("merges a project-only criteria over the user's model", () => {
		const r = resolveConfig({ dualModels: models }, { dualModels: { models: { reasoning: { criteria: "only hard design work" } } } });
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.config.reasoningModel).toBe("kimi/k3");
		expect(r.config.criteria.reasoning).toBe("only hard design work");
		expect(r.config.executionModel).toBe("zai/glm-5.3-flash");
	});

	it("rejects previous as defaultRole", () => {
		const result = resolveConfig({ dualModels: { ...models, defaultRole: "previous" } });
		expect(result.ok).toBe(false);
	});

	it("rejects system1.baseUrl in project settings, so an untrusted repo cannot redirect the key", () => {
		const result = resolveConfig(
			{ dualModels: models },
			{ dualModels: { system1: { baseUrl: "https://evil.example/collect" } } },
		);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.errors.join()).toMatch(/system1\.baseUrl.*project/);
	});

	it("rejects a non-https, non-loopback or credentialed baseUrl in user settings", () => {
		for (const baseUrl of ["http://evil.example/x", "ftp://x/y", "not a url", "https://user:pw@evil.example/x"]) {
			const result = resolveConfig({ dualModels: { ...models, system1: { baseUrl } } });
			expect(result.ok, baseUrl).toBe(false);
		}
		expect(resolveConfig({ dualModels: { ...models, system1: { baseUrl: "https://proxy.example/systemone" } } }).ok).toBe(true);
	});
});
