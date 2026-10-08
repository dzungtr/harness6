import { createHash } from "node:crypto";
import { DEFAULT_CRITERIA } from "./system1.ts";
export type Role = "reasoning" | "execution";
export type EventTarget = "system1" | Role | "previous";
export const EVENT_NAMES = ["prompt", "turn_end", "retry", "compaction", "side-call"] as const;
export type EventName = (typeof EVENT_NAMES)[number];

export interface DualModelsConfig {
	reasoningModel: string;
	executionModel: string;
	/** Effective Gate criteria: defaults with the per-role overrides applied. */
	criteria: Record<Role, string>;
	/** First 12 hex characters of sha256 over the effective criteria. */
	criteriaHash: string;
	system1: { model: string; baseUrl: string; timeoutMs: number };
	digest: { recapTokens: number; toolOutputTokens: number };
	events: Record<EventName, EventTarget>;
	defaultRole: Role;
	forceReasoningOnPrompt: boolean;
}

export type ConfigResult = { ok: true; config: DualModelsConfig } | { ok: false; errors: string[] };

export const DEFAULT_CONFIG = {
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
} as const satisfies Omit<DualModelsConfig, "reasoningModel" | "executionModel" | "criteria" | "criteriaHash">;

const ROOT = "dualModels";
const TARGETS: readonly EventTarget[] = ["system1", "reasoning", "execution", "previous"];
const ROLES: readonly Role[] = ["reasoning", "execution"];

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
	if (isObj(user.models) && isObj(project.models)) {
		const models: Obj = { ...user.models };
		for (const [role, value] of Object.entries(project.models)) {
			models[role] = isObj(value) && isObj(models[role]) ? { ...(models[role] as Obj), ...value } : value;
		}
		out.models = models;
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
		return { ok: false, errors: [`${ROOT}: missing. Add a "${ROOT}" key with models.reasoning.model and models.execution.model to ~/.pi/agent/settings.json`] };
	}
	for (const [scope, raw] of [["user", userRaw], ["project", projectRaw]] as const) {
		if (raw !== undefined && !isObj(raw)) return { ok: false, errors: [`${ROOT}: must be an object (${scope} settings)`] };
	}
	const raw = mergeScopes((userRaw as Obj) ?? {}, (projectRaw as Obj) ?? {});
	const errors: string[] = [];

	if (raw.forceDeliberationOnPrompt !== undefined) {
		errors.push(`${ROOT}.forceDeliberationOnPrompt: removed; use forceReasoningOnPrompt`);
	}
	if (raw.deliberationModel !== undefined) errors.push(`${ROOT}.deliberationModel: removed; use models.reasoning.model`);
	if (raw.executionModel !== undefined) errors.push(`${ROOT}.executionModel: removed; use models.execution.model`);
	const known = new Set(["forceDeliberationOnPrompt", "deliberationModel", "executionModel", "models", "system1", "digest", "events", "defaultRole", "forceReasoningOnPrompt"]);
	for (const key of Object.keys(raw)) if (!known.has(key)) errors.push(`${ROOT}.${key}: unknown key`);

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

	const modelsRaw = raw.models;
	if (modelsRaw !== undefined && !isObj(modelsRaw)) errors.push(`${ROOT}.models: must be an object`);
	const models: Obj = isObj(modelsRaw) ? modelsRaw : {};
	checkKeys("models", models, ROLES);
	const roleSetting = (role: Role): { model: string; criteria: string } => {
		const v = models[role];
		if (v !== undefined && !isObj(v)) {
			errors.push(`${ROOT}.models.${role}: must be an object`);
			return { model: "", criteria: DEFAULT_CRITERIA[role] };
		}
		const obj = v ?? {};
		checkKeys(`models.${role}`, obj, ["model", "criteria"]);
		let model = "";
		if (typeof obj.model !== "string" || !/^[^/\s]+\/\S+$/.test(obj.model)) {
			errors.push(`${ROOT}.models.${role}.model: required, a "provider/modelId" string`);
		} else {
			model = obj.model;
		}
		return { model, criteria: str(`models.${role}.criteria`, obj.criteria, DEFAULT_CRITERIA[role]) };
	};
	const reasoning = roleSetting("reasoning");
	const execution = roleSetting("execution");
	const criteria: Record<Role, string> = { reasoning: reasoning.criteria, execution: execution.criteria };
	const criteriaHash = createHash("sha256").update(JSON.stringify(criteria)).digest("hex").slice(0, 12);

	const s1 = section("system1");
	checkKeys("system1", s1, ["model", "baseUrl", "timeoutMs", "thetaSwitch"]);
	if (s1.thetaSwitch !== undefined) {
		errors.push(`${ROOT}.system1.thetaSwitch: removed; the Gate follows System-1's argmax. Tune with models.<role>.criteria`);
	}
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
		if (v === "deliberation") {
			errors.push(`${ROOT}.events.${name}: removed value "deliberation"; use "reasoning"`);
		} else if (typeof v !== "string" || !TARGETS.includes(v as EventTarget)) {
			errors.push(`${ROOT}.events.${name}: must be one of ${TARGETS.join(", ")}`);
		} else {
			events[name] = v as EventTarget;
		}
	}

	let defaultRole: Role = DEFAULT_CONFIG.defaultRole;
	if (raw.defaultRole !== undefined) {
		if (raw.defaultRole === "deliberation") {
			errors.push(`${ROOT}.defaultRole: removed value "deliberation"; use "reasoning"`);
		} else if (typeof raw.defaultRole !== "string" || !ROLES.includes(raw.defaultRole as Role)) {
			errors.push(`${ROOT}.defaultRole: must be one of ${ROLES.join(", ")}`);
		} else {
			defaultRole = raw.defaultRole as Role;
		}
	}

	let forceReasoningOnPrompt: boolean = DEFAULT_CONFIG.forceReasoningOnPrompt;
	if (raw.forceReasoningOnPrompt !== undefined) {
		if (typeof raw.forceReasoningOnPrompt !== "boolean") errors.push(`${ROOT}.forceReasoningOnPrompt: must be a boolean`);
		else forceReasoningOnPrompt = raw.forceReasoningOnPrompt;
	}

	if (errors.length > 0) return { ok: false, errors };
	return { ok: true, config: { reasoningModel: reasoning.model, executionModel: execution.model, criteria, criteriaHash, system1, digest, events, defaultRole, forceReasoningOnPrompt } };
}
