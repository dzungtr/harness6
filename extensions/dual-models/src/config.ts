export type Role = "deliberation" | "execution";
export type EventTarget = "system1" | Role | "previous";
export const EVENT_NAMES = ["prompt", "turn_end", "retry", "compaction", "side-call"] as const;
export type EventName = (typeof EVENT_NAMES)[number];

export interface DualModelsConfig {
	deliberationModel: string;
	executionModel: string;
	system1: { model: string; baseUrl: string; timeoutMs: number; thetaSwitch: number };
	digest: { recapTokens: number; toolOutputTokens: number };
	events: Record<EventName, EventTarget>;
	defaultRole: Role;
	forceDeliberationOnPrompt: boolean;
}

export type ConfigResult = { ok: true; config: DualModelsConfig } | { ok: false; errors: string[] };

export const DEFAULT_CONFIG = {
	system1: {
		model: "typesafe/jev-1.13",
		baseUrl: "https://openrouter.ai/api/v1/systemone",
		timeoutMs: 1500,
		thetaSwitch: 0.75,
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
} as const satisfies Omit<DualModelsConfig, "deliberationModel" | "executionModel">;

const ROOT = "dualModels";
const TARGETS: readonly EventTarget[] = ["system1", "deliberation", "execution", "previous"];
const ROLES: readonly Role[] = ["deliberation", "execution"];

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function isSafeBaseUrl(value: string): boolean {
	try {
		const u = new URL(value);
		if (u.username || u.password) return false;
		if (u.protocol === "https:") return true;
		return u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
	} catch {
		return false;
	}
}

/** Per-key shallow merge of the nested objects, so a project override can change one field. */
function mergeScopes(user: Obj, project: Obj): Obj {
	const out: Obj = { ...user };
	for (const [key, value] of Object.entries(project)) {
		out[key] = isObj(value) && isObj(user[key]) ? { ...(user[key] as Obj), ...value } : value;
	}
	return out;
}

/**
 * Validate the `dualModels` key of the settings files and fill in defaults.
 * The project settings, when given, override the user settings per key.
 */
export function resolveConfig(userSettings: unknown, projectSettings?: unknown): ConfigResult {
	const userRaw = isObj(userSettings) ? userSettings[ROOT] : undefined;
	const projectRaw = isObj(projectSettings) ? projectSettings[ROOT] : undefined;
	if (userRaw === undefined && projectRaw === undefined) {
		return { ok: false, errors: [`${ROOT}: missing. Add a "${ROOT}" key with deliberationModel and executionModel to ~/.pi/agent/settings.json`] };
	}
	for (const [scope, raw] of [["user", userRaw], ["project", projectRaw]] as const) {
		if (raw !== undefined && !isObj(raw)) return { ok: false, errors: [`${ROOT}: must be an object (${scope} settings)`] };
	}
	const raw = mergeScopes((userRaw as Obj) ?? {}, (projectRaw as Obj) ?? {});
	const errors: string[] = [];

	const known = new Set(["deliberationModel", "executionModel", "system1", "digest", "events", "defaultRole", "forceDeliberationOnPrompt"]);
	for (const key of Object.keys(raw)) if (!known.has(key)) errors.push(`${ROOT}.${key}: unknown key`);

	const modelRef = (key: "deliberationModel" | "executionModel"): string => {
		const v = raw[key];
		if (typeof v !== "string" || !/^[^/\s]+\/\S+$/.test(v)) {
			errors.push(`${ROOT}.${key}: required, a "provider/modelId" string`);
			return "";
		}
		return v;
	};

	const section = (key: "system1" | "digest" | "events"): Obj => {
		const v = raw[key];
		if (v === undefined) return {};
		if (!isObj(v)) {
			errors.push(`${ROOT}.${key}: must be an object`);
			return {};
		}
		return v;
	};

	const checkKeys = (key: string, obj: Obj, allowed: readonly string[]) => {
		for (const k of Object.keys(obj)) if (!allowed.includes(k)) errors.push(`${ROOT}.${key}.${k}: unknown key`);
	};

	const num = (path: string, v: unknown, def: number, ok: (n: number) => boolean, hint: string): number => {
		if (v === undefined) return def;
		if (typeof v !== "number" || !Number.isFinite(v) || !ok(v)) {
			errors.push(`${ROOT}.${path}: must be ${hint}`);
			return def;
		}
		return v;
	};

	const str = (path: string, v: unknown, def: string): string => {
		if (v === undefined) return def;
		if (typeof v !== "string" || v.trim() === "") {
			errors.push(`${ROOT}.${path}: must be a non-empty string`);
			return def;
		}
		return v;
	};

	const deliberationModel = modelRef("deliberationModel");
	const executionModel = modelRef("executionModel");

	const s1 = section("system1");
	checkKeys("system1", s1, ["model", "baseUrl", "timeoutMs", "thetaSwitch"]);
	if (isObj(projectRaw) && isObj(projectRaw.system1) && projectRaw.system1.baseUrl !== undefined) {
		errors.push(`${ROOT}.system1.baseUrl: not allowed in project settings (it receives the OpenRouter key); set it in user settings`);
	}
	if (typeof s1.baseUrl === "string" && s1.baseUrl.trim() !== "" && !isSafeBaseUrl(s1.baseUrl)) {
		errors.push(`${ROOT}.system1.baseUrl: must be an https URL (http only for localhost)`);
	}
	const system1 = {
		model: str("system1.model", s1.model, DEFAULT_CONFIG.system1.model),
		baseUrl: str("system1.baseUrl", s1.baseUrl, DEFAULT_CONFIG.system1.baseUrl),
		timeoutMs: num("system1.timeoutMs", s1.timeoutMs, DEFAULT_CONFIG.system1.timeoutMs, (n) => n > 0, "a positive number"),
		thetaSwitch: num("system1.thetaSwitch", s1.thetaSwitch, DEFAULT_CONFIG.system1.thetaSwitch, (n) => n > 0.5 && n <= 1, "a number above 0.5 and at most 1"),
	};

	const dg = section("digest");
	checkKeys("digest", dg, ["recapTokens", "toolOutputTokens"]);
	const posInt = (n: number) => Number.isInteger(n) && n > 0;
	const digest = {
		recapTokens: num("digest.recapTokens", dg.recapTokens, DEFAULT_CONFIG.digest.recapTokens, posInt, "a positive integer"),
		toolOutputTokens: num("digest.toolOutputTokens", dg.toolOutputTokens, DEFAULT_CONFIG.digest.toolOutputTokens, posInt, "a positive integer"),
	};

	const ev = section("events");
	checkKeys("events", ev, EVENT_NAMES);
	const events = { ...DEFAULT_CONFIG.events } as Record<EventName, EventTarget>;
	for (const name of EVENT_NAMES) {
		const v = ev[name];
		if (v === undefined) continue;
		if (typeof v !== "string" || !TARGETS.includes(v as EventTarget)) {
			errors.push(`${ROOT}.events.${name}: must be one of ${TARGETS.join(", ")}`);
		} else {
			events[name] = v as EventTarget;
		}
	}

	let defaultRole: Role = DEFAULT_CONFIG.defaultRole;
	if (raw.defaultRole !== undefined) {
		if (typeof raw.defaultRole !== "string" || !ROLES.includes(raw.defaultRole as Role)) {
			errors.push(`${ROOT}.defaultRole: must be one of ${ROLES.join(", ")}`);
		} else {
			defaultRole = raw.defaultRole as Role;
		}
	}

	let forceDeliberationOnPrompt: boolean = DEFAULT_CONFIG.forceDeliberationOnPrompt;
	if (raw.forceDeliberationOnPrompt !== undefined) {
		if (typeof raw.forceDeliberationOnPrompt !== "boolean") errors.push(`${ROOT}.forceDeliberationOnPrompt: must be a boolean`);
		else forceDeliberationOnPrompt = raw.forceDeliberationOnPrompt;
	}

	if (errors.length > 0) return { ok: false, errors };
	return { ok: true, config: { deliberationModel, executionModel, system1, digest, events, defaultRole, forceDeliberationOnPrompt } };
}
