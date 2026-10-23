import type { ModelRouteRequest } from "@earendil-works/pi-coding-agent";
import { compact, countTokens, truncateHeadTail } from "./text.ts";

type Message = ModelRouteRequest["messages"][number];

/** The parts of a message this module reads. The SDK's unions are wider, so it narrows structurally. */
interface Part {
	type: string;
	text?: string;
	id?: string;
	name?: string;
	arguments?: Record<string, unknown>;
}
interface AssistantLike {
	role: "assistant";
	content: readonly Part[];
}
interface ToolResultLike {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	isError: boolean;
	content: readonly Part[];
}

/** Characters of a call's arguments kept per call. Args identify the step; their bodies rarely matter. */
const ARGS_PREVIEW_CHARS = 80;
/** Share of the step budget the results may take; the assistant text gets whatever is left. */
const RESULT_SHARE = 0.7;
/** Share of the result budget error results may take, so an error is never the part that gets dropped. */
const ERROR_SHARE = 0.6;

export interface Call {
	name: string;
	args: string;
}
export interface CallResult {
	name: string;
	text: string;
	isError: boolean;
}

/** One completed step: the assistant message that made the calls, and what the calls returned. */
export interface PreviousStep {
	assistant: string;
	calls: Call[];
	/** Paired with `calls` by index; `undefined` when that call has no result in this step. */
	results: (CallResult | undefined)[];
}

function textOf(parts: readonly Part[]): string {
	const text = parts
		.filter((p) => p.type === "text")
		.map((p) => p.text ?? "")
		.filter((t) => t.length > 0)
		.join("\n");
	if (text) return compact(text);
	return parts.some((p) => p.type === "image") ? "(image)" : "";
}

function previewArgs(args: unknown): string {
	let json: string;
	try {
		json = JSON.stringify(args ?? {}) ?? "{}";
	} catch {
		json = "{}";
	}
	if (json.length <= ARGS_PREVIEW_CHARS) return json;
	const keep = ARGS_PREVIEW_CHARS - 1;
	const head = Math.ceil(keep / 2);
	const tail = Math.floor(keep / 2);
	return `${json.slice(0, head)}…${json.slice(-tail)}`;
}

const roleOf = (m: Message | undefined): string | undefined => (m as { role?: string } | undefined)?.role;

/**
 * Read the step the request just finished: the trailing tool results and the assistant message that
 * made their calls. Undefined unless the last message is a tool result of an assistant tool call in
 * the same turn, so a new prompt and a text-only assistant message produce no step.
 */
export function readPreviousStep(messages: readonly Message[]): PreviousStep | undefined {
	if (roleOf(messages[messages.length - 1]) !== "toolResult") return undefined;
	let at = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (roleOf(messages[i]) === "assistant") {
			at = i;
			break;
		}
		// A user message between the results and the call means the step belongs to an earlier turn.
		if (roleOf(messages[i]) === "user") return undefined;
	}
	if (at < 0) return undefined;

	const parts = (messages[at] as AssistantLike).content ?? [];
	const calls = parts.filter((p) => p.type === "toolCall");
	if (calls.length === 0) return undefined;

	const byId = new Map<string, CallResult>();
	for (const message of messages.slice(at + 1)) {
		const result = message as ToolResultLike;
		if (result.role !== "toolResult") continue;
		byId.set(result.toolCallId, { name: result.toolName, text: textOf(result.content), isError: !!result.isError });
	}
	return {
		assistant: textOf(parts),
		calls: calls.map((p) => ({ name: p.name ?? "?", args: previewArgs(p.arguments) })),
		results: calls.map((p) => byId.get(p.id ?? "")),
	};
}

/** One line per result, in call order, each truncated to its own share of the result budget. */
function renderResults(results: (CallResult | undefined)[], budget: number): string[] {
	const present = results.filter((r): r is CallResult => r !== undefined);
	if (present.length === 0 || budget < 8) return [];
	const share = (total: number, n: number) => Math.max(1, Math.floor(total / n));
	const errors = present.filter((r) => r.isError).length;
	const errorEach = errors > 0 ? share(Math.floor(budget * ERROR_SHARE), errors) : 0;
	const okEach = share(budget - errorEach * errors, present.length - errors);
	const lines: string[] = [];
	results.forEach((result, i) => {
		if (!result) return;
		const cap = result.isError ? errorEach : okEach;
		lines.push(`${i + 1}. ${result.name} ${result.isError ? "error" : "ok"}:\n${truncateHeadTail(result.text || "(no output)", cap)}`);
	});
	return lines;
}

/**
 * Render the `Previous step:` block, or "" when the calls alone do not fit `budget`. The assistant
 * text is bounded by whatever the calls and results leave, so the evidence always survives.
 */
export function renderPreviousStep(step: PreviousStep, budget: number): string {
	const header = "Previous step:";
	const callLines = ["calls:", ...step.calls.map((c, i) => `${i + 1}. ${c.name} ${c.args}`)];
	const fixedTokens = countTokens([header, ...callLines].join("\n"));
	if (fixedTokens >= budget) return "";

	let remaining = budget - fixedTokens;
	const resultLines = renderResults(step.results, Math.floor(remaining * RESULT_SHARE));
	if (resultLines.length > 0) remaining -= countTokens(["results:", ...resultLines].join("\n"));
	const assistantBudget = remaining - countTokens("assistant: ");
	const assistant = assistantBudget > 4 ? truncateHeadTail(step.assistant, assistantBudget) : "";

	const lines = [header, assistant ? `assistant: ${assistant}` : "", ...callLines, ...(resultLines.length > 0 ? ["results:", ...resultLines] : [])].filter((l) => l !== "");
	const text = lines.join("\n");
	return countTokens(text) <= budget ? text : truncateHeadTail(text, budget);
}

/** The text of the newest user message: the prompt a `prompt` route is deciding about. */
export function latestUserText(messages: readonly Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i] as { role?: string; content?: string | readonly Part[] };
		if (message.role !== "user") continue;
		if (typeof message.content === "string") return message.content;
		return textOf(message.content ?? []);
	}
	return "";
}

/** Render the `New prompt:` block, or "" when the request carries no user text. */
export function renderNewPrompt(messages: readonly Message[], budget: number): string {
	const prompt = latestUserText(messages);
	return prompt ? `New prompt:\n${truncateHeadTail(prompt, budget)}` : "";
}
