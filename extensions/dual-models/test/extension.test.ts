import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import dualModels from "../src/index.ts";

const settings = {
	dualModels: { deliberationModel: "kimi/k3", executionModel: "zai/glm-5.3-flash" },
	someOtherExtension: { keep: true },
};

function load() {
	const handlers: Record<string, (...a: any[]) => unknown> = {};
	let virtualModel: any;
	dualModels({
		on: (name: string, h: any) => {
			const prev = handlers[name];
			handlers[name] = prev ? (...a: any[]) => (prev(...a), h(...a)) : h;
		},
		registerVirtualModel: (m: unknown) => void (virtualModel = m),
		registerTool: () => {},
		appendEntry: () => {},
	} as never);
	return { handlers, virtualModel };
}

function ctxFor(cwd: string, notify = vi.fn()) {
	const m = { provider: "kimi", id: "k3" };
	return {
		cwd,
		isProjectTrusted: () => false,
		ui: { notify },
		sessionManager: { getBranch: () => [], getSessionId: () => "s" },
		modelRegistry: { find: () => m },
		m,
	};
}

describe("extension wiring", () => {
	it("registers the dual-models/auto virtual model and a session_start handler", () => {
		const { handlers, virtualModel } = load();
		expect(virtualModel).toMatchObject({ provider: "dual-models", id: "auto" });
		expect(typeof virtualModel.route).toBe("function");
		expect(typeof handlers.session_start).toBe("function");
	});

	it("notifies a clear error at session_start when dualModels is missing", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "dm-agent-"));
		writeFileSync(join(agentDir, "settings.json"), "{}");
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
		const { handlers } = load();
		const notify = vi.fn();
		handlers.session_start({ type: "session_start", reason: "startup" }, ctxFor(agentDir, notify));
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("dualModels"), "error");
		vi.unstubAllEnvs();
	});

	it("loads valid config from user settings and routes without notifying", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "dm-agent-"));
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify(settings));
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
		const { handlers, virtualModel } = load();
		const ctx = ctxFor(agentDir);
		handlers.session_start({ type: "session_start", reason: "startup" }, ctx);
		expect(ctx.ui.notify).not.toHaveBeenCalled();
		const route = await virtualModel.route({ reason: "continuation", thinkingLevel: "low", messages: [] }, ctx);
		expect(route.model).toBe(ctx.m);
		vi.unstubAllEnvs();
	});
});

describe("Pi settings.json rewrite (handoff evidence)", () => {
	it("preserves the unknown dualModels key when Pi rewrites settings", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "dm-cwd-"));
		const agentDir = mkdtempSync(join(tmpdir(), "dm-agent-"));
		mkdirSync(join(cwd, ".pi"));
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify(settings, null, 2));
		const manager = SettingsManager.create(cwd, agentDir);
		manager.setDefaultThinkingLevel("high");
		await manager.flush();
		const after = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
		expect(after.defaultThinkingLevel).toBe("high");
		expect(after.dualModels).toEqual(settings.dualModels);
		expect(after.someOtherExtension).toEqual(settings.someOtherExtension);
	});
});
