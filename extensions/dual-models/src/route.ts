import type { ExtensionContext, ModelRoute, ModelRouteRequest } from "@earendil-works/pi-coding-agent";
import type { ConfigResult, Role } from "./config.ts";
import type { Digest } from "./recap.ts";
import { decide } from "./system1.ts";

export type Router = ((request: ModelRouteRequest, ctx: ExtensionContext) => Promise<ModelRoute>) & {
	/** Clear the failure count and re-enable the Gate (a new session). */
	reset(): void;
};

const MAX_CONSECUTIVE_FAILURES = 3;

/**
 * Build the Virtual Model `route()`. A `user` request asks System-1 the Gate question and is served by the
 * argmax role. Every other reason, and any System-1 failure, is served by `defaultRole`.
 * Only `model` and `thinkingLevel` are returned, so the system prompt and tool list never depend on the role.
 */
export function createRouter(getConfig: () => ConfigResult, buildDigest: () => Digest): Router {
	let failures = 0;

	const route = async (request: ModelRouteRequest, ctx: ExtensionContext): Promise<ModelRoute> => {
		const result = getConfig();
		if (!result.ok) throw new Error(`Dual Models config is invalid:\n${result.errors.join("\n")}`);
		const { config } = result;

		const pick = (role: Role): ModelRoute => {
			const ref = role === "deliberation" ? config.deliberationModel : config.executionModel;
			const slash = ref.indexOf("/");
			const model = ctx.modelRegistry.find(ref.slice(0, slash), ref.slice(slash + 1));
			if (!model) throw new Error(`Dual Models: model ${ref} is not in the Pi catalog`);
			return { model, thinkingLevel: request.thinkingLevel };
		};

		if (request.reason !== "user") return pick(config.defaultRole);
		if (config.forceDeliberationOnPrompt) return pick("deliberation");
		if (failures >= MAX_CONSECUTIVE_FAILURES) return pick(config.defaultRole);

		const outcome = await decide(buildDigest().state, { ...config.system1, signal: request.signal });
		if (outcome.ok) {
			failures = 0;
			const { pDeliberation, pExecution } = outcome.decision;
			return pick(pDeliberation >= pExecution ? "deliberation" : "execution");
		}

		failures++;
		const reason = outcome.detail ? `${outcome.failure}: ${outcome.detail}` : outcome.failure;
		if (failures >= MAX_CONSECUTIVE_FAILURES) {
			ctx.ui.notify(`Dual Models: System-1 failed ${failures} times in a row (${reason}). Gate disabled for this session, using ${config.defaultRole}.`, "warning");
		} else {
			ctx.ui.notify(`Dual Models: System-1 unavailable (${reason}), using ${config.defaultRole}.`, "warning");
		}
		return pick(config.defaultRole);
	};
	return Object.assign(route, { reset: () => void (failures = 0) });
}
