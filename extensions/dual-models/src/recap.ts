import { type ExtensionAPI, type ModelRouteRequest } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readPreviousStep, renderPreviousStep } from "./step.ts";
import { recordRecapSpan } from "./telemetry.ts";
import { countTokens, truncateHeadTail } from "./text.ts";

export const RECAP_ENTRY = "dual-models.recap";

export interface DigestBudgets {
	recapTokens: number;
	stepTokens: number;
}

export interface Digest {
	state: string;
	tokens: number;
}

interface RecapState {
	intent: string;
	courseOfAction: string;
	events: string[];
}

const EMPTY: RecapState = { intent: "", courseOfAction: "", events: [] };

export { countTokens, truncateHeadTail } from "./text.ts";

function renderRecap(s: RecapState): string {
	const lines = [`Intent: ${s.intent || "(not set)"}`, `Course of action: ${s.courseOfAction || "(not set)"}`];
	if (s.events.length > 0) lines.push("Events:", ...s.events.map((e) => `- ${e}`));
	return lines.join("\n");
}

function parseState(data: unknown): RecapState | undefined {
	if (typeof data !== "object" || data === null) return undefined;
	const d = data as Partial<RecapState>;
	if (typeof d.intent !== "string" || typeof d.courseOfAction !== "string" || !Array.isArray(d.events)) return undefined;
	return { intent: d.intent, courseOfAction: d.courseOfAction, events: d.events.filter((e): e is string => typeof e === "string") };
}

const DESCRIPTION = [
	"Record the session Recap: your intent, your course of action, and significant events. The router reads it to decide how much reasoning each turn needs.",
	"Write it once you understand the task and have settled on a course of action, then only when the intent or course of action changes or on a significant event: a blocker, a surprise, an off-plan finding, or a completed step.",
	"Never write routinely or every turn. Keep entries brief: the Recap has a hard token budget, and an over-budget write is rejected and not stored.",
	"Provide intent and courseOfAction to replace them; provide event to append one (the oldest events age out).",
].join(" ");

const PROMPT_SNIPPET = "recap: Record your intent, course of action and significant events for model routing";

const PROMPT_GUIDELINES = [
	"Call recap as soon as you understand the task and have settled on a course of action, before you carry it out: set intent and courseOfAction.",
	"Call recap again on a significant event: a blocker, a finding that changes your course of action, or a completed step. Update courseOfAction when it changes.",
	"Do not call recap every turn, and keep each entry brief.",
];

/**
 * Register the `recap` tool (identical for both roles) and build the Digest from it.
 * The Recap is persisted on the session branch and restored on session start and tree navigation.
 */
export function registerRecap(pi: ExtensionAPI, getBudgets: () => DigestBudgets) {
	let state: RecapState = EMPTY;

	const restore = (_event: unknown, ctx: { sessionManager: { getBranch(): any[] } }) => {
		state = EMPTY;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== RECAP_ENTRY) continue;
			state = parseState(entry.data) ?? state;
		}
	};
	pi.on("session_start", restore);
	pi.on("session_tree", restore);

	pi.registerTool({
		name: "recap",
		label: "Recap",
		description: DESCRIPTION,
		promptSnippet: PROMPT_SNIPPET,
		promptGuidelines: PROMPT_GUIDELINES,
		parameters: Type.Object({
			intent: Type.Optional(Type.String({ description: "The current intent. Replaces the previous one." })),
			courseOfAction: Type.Optional(Type.String({ description: "The current course of action. Replaces the previous one." })),
			event: Type.Optional(Type.String({ description: "One significant event to append." })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const span = { sessionId: ctx.sessionManager.getSessionId(), budget: getBudgets().recapTokens };
			if (params.intent === undefined && params.courseOfAction === undefined && params.event === undefined) {
				const err = new Error("recap: provide at least one of intent, courseOfAction, event");
				recordRecapSpan(span, err);
				throw err;
			}
			const budget = getBudgets().recapTokens;
			const next: RecapState = {
				intent: params.intent ?? state.intent,
				courseOfAction: params.courseOfAction ?? state.courseOfAction,
				events: params.event === undefined ? [...state.events] : [...state.events, params.event],
			};
			const keepAtLeast = params.event === undefined ? 0 : 1;
			while (countTokens(renderRecap(next)) > budget && next.events.length > keepAtLeast) next.events.shift();
			const used = countTokens(renderRecap(next));
			if (used > budget) {
				const err = new Error(`recap: write rejected, the Recap would use ${used} tokens against a budget of ${budget}. Be briefer. Nothing was stored.`);
				recordRecapSpan(span, err);
				throw err;
			}
			state = next;
			pi.appendEntry(RECAP_ENTRY, state);
			recordRecapSpan(span, { intent: state.intent, courseOfAction: state.courseOfAction, event: params.event, eventCount: state.events.length, tokens: used });
			return { content: [{ type: "text", text: `Recap saved (${used}/${budget} tokens).` }], details: undefined };
		},
	});

	return {
		/**
		 * The input System-1 judges from: the Recap and, unless it is left out, the `Previous step:`
		 * block. It never names the current role.
		 */
		buildDigest(request: ModelRouteRequest, opts: { step?: boolean } = {}): Digest {
			const budgets = getBudgets();
			// The budget is enforced on write, so re-check it here in case it was lowered since.
			const fit: RecapState = { ...state, events: [...state.events] };
			while (countTokens(renderRecap(fit)) > budgets.recapTokens && fit.events.length > 0) fit.events.shift();
			let text = truncateHeadTail(renderRecap(fit), budgets.recapTokens);
			if (opts.step !== false) {
				const step = readPreviousStep(request.messages);
				const block = step ? renderPreviousStep(step, budgets.stepTokens) : "";
				if (block) text += `\n\n${block}`;
			}
			return { state: text, tokens: countTokens(text) };
		},
	};
}
