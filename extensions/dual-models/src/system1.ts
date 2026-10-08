import type { Role } from "./config.ts";

export interface Decision {
	pReasoning: number;
	pExecution: number;
}

export type Failure = "no-key" | "timeout" | "http" | "malformed";

export type DecideResult = { ok: true; decision: Decision } | { ok: false; failure: Failure; detail?: string };

export interface System1Options {
	model: string;
	baseUrl: string;
	timeoutMs: number;
	criteria: Record<Role, string>;
	signal?: AbortSignal;
}

const GATE_NAME = "role";

/** Default Gate criteria per role. `models.<role>.criteria` overrides each independently. */
export const DEFAULT_CRITERIA: Record<Role, string> = {
	reasoning:
		"The request needs intent clarification, planning, design or judgment: it is ambiguous, complex, open-ended, risky, or something unexpected needs to be understood before acting.",
	execution:
		"The request is clear and routine: the next step is well defined, such as a mechanical edit, running a command, or carrying out an agreed course of action.",
};

/** The Gate: one mode-agnostic question. Its wording never depends on the current role. */
export function gateQuestion(criteria: Record<Role, string>) {
	return {
		type: "choice",
		instructions: "Which role should take the next request?",
		criteria: { reasoning: criteria.reasoning, execution: criteria.execution },
	};
}

/** Ask System-1 the Gate question about the Digest. Never throws. */
export async function decide(digest: string, opts: System1Options): Promise<DecideResult> {
	const key = process.env.OPENROUTER_API_KEY;
	if (!key) return { ok: false, failure: "no-key" };

	const timeout = AbortSignal.timeout(opts.timeoutMs);
	const signal = opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout;
	try {
		const res = await fetch(opts.baseUrl, {
			method: "POST",
			headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
			body: JSON.stringify({ model: opts.model, state: digest, questions: { [GATE_NAME]: gateQuestion(opts.criteria) } }),
			signal,
		});
		if (!res.ok) return { ok: false, failure: "http", detail: `HTTP ${res.status}` };
		const probs = ((await res.json()) as any)?.answers?.[GATE_NAME]?.probabilities;
		const pReasoning = probs?.reasoning;
		const pExecution = probs?.execution;
		if (typeof pReasoning !== "number" || typeof pExecution !== "number") {
			return { ok: false, failure: "malformed", detail: "response has no choice probabilities" };
		}
		return { ok: true, decision: { pReasoning, pExecution } };
	} catch (e) {
		if (timeout.aborted) return { ok: false, failure: "timeout", detail: `no answer within ${opts.timeoutMs} ms` };
		return { ok: false, failure: "http", detail: (e as Error).message };
	}
}
