import type { ExtensionContext, ModelRoute, ModelRouteRequest } from "@earendil-works/pi-coding-agent";
import type { ConfigResult, EventName, Role } from "./config.ts";
import { countTokens, type Digest, truncateHeadTail } from "./recap.ts";
import { decide } from "./system1.ts";
import { startGateSpan } from "./telemetry.ts";

export type Router = ((request: ModelRouteRequest, ctx: ExtensionContext) => Promise<ModelRoute>) & {
	/** Clear the failure count and re-enable the Gate (a new session). */
	reset(): void;
};

function latestUserText(request: ModelRouteRequest): string {
	for (let i = request.messages.length - 1; i >= 0; i--) {
		const m = request.messages[i];
		if (m.role !== "user") continue;
		if (typeof m.content === "string") return m.content;
		return m.content.map((part) => (part.type === "text" ? part.text : "")).filter(Boolean).join("\n");
	}
	return "";
}

/** Append the new prompt to the Digest, truncated head and tail to `budget` tokens. */
function withPrompt(state: string, request: ModelRouteRequest, budget: number): string {
	const prompt = latestUserText(request);
	return prompt ? `${state}\n\nNew prompt:\n${truncateHeadTail(prompt, budget)}` : state;
}

const MAX_CONSECUTIVE_FAILURES = 3;

function eventOf(request: ModelRouteRequest, compacting: boolean): EventName {
	switch (request.reason) {
		case "user":
			return "prompt";
		case "continuation":
			return "turn_end";
		case "retry":
			return "retry";
		case "direct":
			return compacting ? "compaction" : "side-call";
	}
}

/**
 * Build the Virtual Model `route()`. The request's reason maps to an event, and the event map names the target:
 * a fixed role, `previous` (the role that served the last response), or `system1`, which asks the Gate.
 * The Gate takes System-1's argmax (a tie goes to reasoning). Any System-1 failure is served by `defaultRole`.
 * Only `model` and `thinkingLevel` are returned, so the system prompt and tool list never depend on the role.
 */
export function createRouter(getConfig: () => ConfigResult, buildDigest: (opts?: { toolOutput?: boolean }) => Digest, isCompacting: () => boolean = () => false): Router {
	let failures = 0;

	const route = async (request: ModelRouteRequest, ctx: ExtensionContext): Promise<ModelRoute> => {
		const result = getConfig();
		if (!result.ok) throw new Error(`Dual Models config is invalid:\n${result.errors.join("\n")}`);
		const { config } = result;

		const split = (ref: string): [string, string] => [ref.slice(0, ref.indexOf("/")), ref.slice(ref.indexOf("/") + 1)];
		const pick = (role: Role): ModelRoute => {
			const [provider, id] = split(role === "reasoning" ? config.reasoningModel : config.executionModel);
			const model = ctx.modelRegistry.find(provider, id);
			if (!model) throw new Error(`Dual Models: model ${provider}/${id} is not in the Pi catalog`);
			return { model, thinkingLevel: request.thinkingLevel };
		};
		const roleOfPrevious = (): Role | undefined => {
			const prev = request.previous?.model;
			if (!prev) return undefined;
			for (const role of ["reasoning", "execution"] as const) {
				const [provider, id] = split(role === "reasoning" ? config.reasoningModel : config.executionModel);
				if (prev.provider === provider && prev.id === id) return role;
			}
			return undefined;
		};

		const event = eventOf(request, isCompacting());
		if (event === "prompt" && config.forceReasoningOnPrompt) return pick("reasoning");
		const target = config.events[event];
		if (target === "previous") return pick(roleOfPrevious() ?? config.defaultRole);
		if (target !== "system1") return pick(target);
		if (failures >= MAX_CONSECUTIVE_FAILURES) return pick(config.defaultRole);

		const sent = event === "prompt" ? withPrompt(buildDigest({ toolOutput: false }).state, request, config.digest.toolOutputTokens) : buildDigest().state;
		const current = roleOfPrevious();
		const span = startGateSpan({ event, system1Model: config.system1.model, sessionId: ctx.sessionManager.getSessionId(), previous: current, digestTokens: countTokens(sent), criteriaHash: config.criteriaHash });
		const outcome = await decide(sent, { ...config.system1, criteria: config.criteria, signal: request.signal });
		if (outcome.ok) {
			failures = 0;
			const { pReasoning, pExecution } = outcome.decision;
			const chosen: Role = pReasoning >= pExecution ? "reasoning" : "execution";
			span.end(outcome, chosen);
			return pick(chosen);
		}
		span.end(outcome, config.defaultRole);

		failures++;
		if (failures >= MAX_CONSECUTIVE_FAILURES) {
			const reason = outcome.detail ? `${outcome.failure}: ${outcome.detail}` : outcome.failure;
			ctx.ui.notify(`Dual Models: System-1 failed ${failures} times in a row (${reason}). Gate disabled for this session, using ${config.defaultRole}.`, "warning");
		}
		return pick(config.defaultRole);
	};
	return Object.assign(route, { reset: () => void (failures = 0) });
}
