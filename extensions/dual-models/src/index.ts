import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { type ConfigResult, DEFAULT_CONFIG, resolveConfig } from "./config.ts";
import { registerRecap } from "./recap.ts";
import { createRouter } from "./route.ts";
import { flushTelemetry } from "./telemetry.ts";

function readJson(path: string): { value?: unknown; error?: string } {
	if (!existsSync(path)) return {};
	try {
		return { value: JSON.parse(readFileSync(path, "utf8")) };
	} catch (e) {
		return { error: `${path}: ${(e as Error).message}` };
	}
}

/** Read `dualModels` from user settings, plus the project override once the project is trusted. */
export function loadConfig(cwd: string, projectTrusted: boolean): ConfigResult {
	const user = readJson(join(getAgentDir(), "settings.json"));
	const project = projectTrusted ? readJson(join(cwd, CONFIG_DIR_NAME, "settings.json")) : {};
	const parseErrors = [user.error, project.error].filter((e): e is string => !!e);
	if (parseErrors.length > 0) return { ok: false, errors: parseErrors.map((e) => `Cannot parse settings: ${e}`) };
	return resolveConfig(user.value, project.value);
}

export default function dualModels(pi: ExtensionAPI) {
	let current: ConfigResult = { ok: false, errors: ["dualModels: config not loaded yet (session_start has not fired)"] };

	let router: ReturnType<typeof createRouter>;

	pi.on("session_start", (_event, ctx: ExtensionContext) => {
		router.reset();
		current = loadConfig(ctx.cwd, ctx.isProjectTrusted());
		if (!current.ok) ctx.ui.notify(`Dual Models: invalid config\n${current.errors.join("\n")}`, "error");
	});

	pi.on("session_shutdown", () => flushTelemetry());

	const recap = registerRecap(pi, () => (current.ok ? current.config.digest : DEFAULT_CONFIG.digest));

	router = createRouter(() => current, recap.buildDigest);

	pi.registerVirtualModel({
		provider: "dual-models",
		id: "auto",
		name: "Dual Models",
		thinkingLevels: ["off", "minimal", "low", "medium", "high"],
		route: router,
	});
}
