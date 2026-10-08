import { type ExtensionAPI, estimateTokens } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const RECAP_ENTRY = "dual-models.recap";

export interface DigestBudgets {
	recapTokens: number;
	toolOutputTokens: number;
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

export const countTokens = (text: string) => estimateTokens({ role: "user", content: text, timestamp: 0 } as never);

function renderRecap(s: RecapState): string {
	const lines = [`Intent: ${s.intent || "(not set)"}`, `Course of action: ${s.courseOfAction || "(not set)"}`];
	if (s.events.length > 0) lines.push("Events:", ...s.events.map((e) => `- ${e}`));
	return lines.join("\n");
}

/** Keep the head and tail of `text` so the result stays within `budget` tokens. */
export function truncateHeadTail(text: string, budget: number): string {
	if (countTokens(text) <= budget) return text;
	const marker = "\n[... truncated ...]\n";
	const keep = Math.max(0, budget * 4 - marker.length - 4);
	const head = Math.ceil(keep / 2);
	const tail = Math.floor(keep / 2);
	return text.slice(0, head) + marker + (tail > 0 ? text.slice(-tail) : "");
}

function parseState(data: unknown): RecapState | undefined {
	if (typeof data !== "object" || data === null) return undefined;
	const d = data as Partial<RecapState>;
	if (typeof d.intent !== "string" || typeof d.courseOfAction !== "string" || !Array.isArray(d.events)) return undefined;
	return { intent: d.intent, courseOfAction: d.courseOfAction, events: d.events.filter((e): e is string => typeof e === "string") };
}

const DESCRIPTION = [
	"Record the session Recap: your intent, your course of action, and significant events.",
	"Write ONLY when the intent or course of action changes, or on a significant event: a blocker, a surprise, an off-plan finding, or a completed step.",
	"Never write routinely or every turn. Keep entries brief: the Recap has a hard token budget, and an over-budget write is rejected and not stored.",
	"Provide intent and courseOfAction to replace them; provide event to append one (the oldest events age out).",
].join(" ");

/**
 * Register the `recap` tool (identical for both roles) and track the last tool output.
 * The Recap is persisted on the session branch and restored on session start and tree navigation.
 */
export function registerRecap(pi: ExtensionAPI, getBudgets: () => DigestBudgets) {
	let state: RecapState = EMPTY;
	let lastToolOutput = "";

	const restore = (_event: unknown, ctx: { sessionManager: { getBranch(): any[] } }) => {
		state = EMPTY;
		lastToolOutput = "";
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== RECAP_ENTRY) continue;
			state = parseState(entry.data) ?? state;
		}
	};
	pi.on("session_start", restore);
	pi.on("session_tree", restore);

	pi.on("tool_result", (event) => {
		if ((event as { toolName: string }).toolName === "recap") return;
		lastToolOutput = event.content
			.map((c) => (c.type === "text" ? c.text : ""))
			.filter(Boolean)
			.join("\n");
	});

	pi.registerTool({
		name: "recap",
		label: "Recap",
		description: DESCRIPTION,
		parameters: Type.Object({
			intent: Type.Optional(Type.String({ description: "The current intent. Replaces the previous one." })),
			courseOfAction: Type.Optional(Type.String({ description: "The current course of action. Replaces the previous one." })),
			event: Type.Optional(Type.String({ description: "One significant event to append." })),
		}),
		async execute(_id, params) {
			if (params.intent === undefined && params.courseOfAction === undefined && params.event === undefined) {
				throw new Error("recap: provide at least one of intent, courseOfAction, event");
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
				throw new Error(`recap: write rejected, the Recap would use ${used} tokens against a budget of ${budget}. Be briefer. Nothing was stored.`);
			}
			state = next;
			pi.appendEntry(RECAP_ENTRY, state);
			return { content: [{ type: "text", text: `Recap saved (${used}/${budget} tokens).` }], details: undefined };
		},
	});

	return {
		/** The input System-1 judges from: the Recap plus the last tool output. It never names the current role. */
		buildDigest(opts: { toolOutput?: boolean } = {}): Digest {
			const budgets = getBudgets();
			// The budget is enforced on write, so re-check it here in case it was lowered since.
			const fit: RecapState = { ...state, events: [...state.events] };
			while (countTokens(renderRecap(fit)) > budgets.recapTokens && fit.events.length > 0) fit.events.shift();
			let text = truncateHeadTail(renderRecap(fit), budgets.recapTokens);
			if (opts.toolOutput !== false && lastToolOutput) text += `\n\nLast tool output:\n${truncateHeadTail(lastToolOutput, budgets.toolOutputTokens)}`;
			return { state: text, tokens: countTokens(text) };
		},
	};
}
