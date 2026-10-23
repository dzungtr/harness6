import { estimateTokens } from "@earendil-works/pi-coding-agent";
import type { ModelRouteRequest } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { registerRecap } from "../src/recap.ts";

const tokens = (text: string) => estimateTokens({ role: "user", content: text, timestamp: 0 } as never);

interface Harness {
	tool: any;
	entries: { customType: string; data: unknown }[];
	recap: ReturnType<typeof registerRecap>;
	fire: (name: string, event: unknown) => void;
	write: (params: Record<string, string>) => Promise<any>;
}

function setup(budgets = { recapTokens: 2000, stepTokens: 1200 }, restored: unknown[] = []): Harness {
	const handlers: Record<string, ((e: any, c: any) => void)[]> = {};
	const entries: { customType: string; data: unknown }[] = [];
	let tool: any;
	const pi = {
		on: (name: string, h: any) => void (handlers[name] ??= []).push(h),
		registerTool: (t: unknown) => void (tool = t),
		appendEntry: (customType: string, data: unknown) => void entries.push({ customType, data }),
	};
	const recap = registerRecap(pi as never, () => budgets);
	const branch = restored.map((data) => ({ type: "custom", customType: "dual-models.recap", data }));
	const ctx = { sessionManager: { getBranch: () => branch, getSessionId: () => "sess-42" } };
	const fire = (name: string, event: unknown) => (handlers[name] ?? []).forEach((h) => h(event, ctx));
	fire("session_start", { type: "session_start", reason: "startup" });
	return { tool, entries, recap, fire, write: (params) => tool.execute("id", params, undefined, undefined, ctx) };
}

const userMsg = (text: string) => ({ role: "user", content: [{ type: "text", text }] });
const assistantMsg = (text: string, calls: [string, Record<string, unknown>][]) => ({
	role: "assistant",
	content: [...(text ? [{ type: "text", text }] : []), ...calls.map(([name, args], i) => ({ type: "toolCall", id: `c${i}`, name, arguments: args }))],
});
const resultMsg = (toolName: string, text: string, isError = false, id = "c0") => ({
	role: "toolResult",
	toolCallId: id,
	toolName,
	isError,
	content: [{ type: "text", text }],
});
const request = (messages: unknown[]): ModelRouteRequest => ({ messages } as never);

describe("recap tool", () => {
	it("is registered with strict write-only-on-change instructions", () => {
		const { tool } = setup();
		expect(tool.name).toBe("recap");
		expect(tool.description).toMatch(/only/i);
		expect(tool.description).toMatch(/never.*(routine|every turn)/i);
	});

	it("surfaces itself in the system prompt with a snippet and guidelines", () => {
		const { tool } = setup();
		expect(tool.promptSnippet).toMatch(/^recap: \S/);
		expect(tool.promptGuidelines.length).toBeGreaterThan(0);
		expect(tool.promptGuidelines.every((g: string) => g.trim().length > 0)).toBe(true);
		expect(tool.promptGuidelines.join(" ")).toMatch(/before you carry it out/i);
	});

	it("replaces the header on each write", async () => {
		const h = setup();
		await h.write({ intent: "fix billing", courseOfAction: "step A" });
		await h.write({ intent: "fix invoices", courseOfAction: "step B" });
		const { state } = h.recap.buildDigest(request([]));
		expect(state).toContain("fix invoices");
		expect(state).toContain("step B");
		expect(state).not.toContain("fix billing");
		expect(state).not.toContain("step A");
	});

	it("keeps events FIFO within the budget, evicting the oldest", async () => {
		const h = setup({ recapTokens: 60, stepTokens: 100 });
		await h.write({ intent: "i", courseOfAction: "c" });
		for (const n of [1, 2, 3, 4, 5, 6, 7, 8]) await h.write({ event: `event-${n} ${"x".repeat(40)}` });
		const { state } = h.recap.buildDigest(request([]));
		expect(state).toContain("event-8");
		expect(state).not.toContain("event-1 ");
		expect(tokens(state)).toBeLessThanOrEqual(60);
	});

	it("rejects an over-budget write with an error and leaves state unchanged", async () => {
		const h = setup({ recapTokens: 30, stepTokens: 100 });
		await h.write({ intent: "short", courseOfAction: "plan" });
		const before = h.recap.buildDigest(request([])).state;
		const entriesBefore = h.entries.length;
		await expect(h.write({ intent: "y".repeat(400) })).rejects.toThrow(/budget/i);
		expect(h.recap.buildDigest(request([])).state).toBe(before);
		expect(h.entries.length).toBe(entriesBefore);
	});

	it("rejects an empty write", async () => {
		await expect(setup().write({})).rejects.toThrow();
	});

	it("restores the recap after a session resume", async () => {
		const first = setup();
		await first.write({ intent: "ship feature", courseOfAction: "three steps" });
		await first.write({ event: "step 1 done" });
		const resumed = setup(undefined, first.entries.map((e) => e.data));
		const { state } = resumed.recap.buildDigest(request([]));
		expect(state).toContain("ship feature");
		expect(state).toContain("step 1 done");
	});
});

describe("digest builder", () => {
	it("contains the recap but no role field", async () => {
		const h = setup();
		await h.write({ intent: "goal", courseOfAction: "plan" });
		const digest = h.recap.buildDigest(request([]));
		expect(digest.state).toContain("goal");
		expect(digest.state).not.toMatch(/role|reasoning|execution/i);
		expect(digest.tokens).toBe(tokens(digest.state));
	});

	it("adds the previous step for a trailing assistant call with its results", async () => {
		const h = setup();
		const digest = h.recap.buildDigest(
			request([
				userMsg("run the suite"),
				assistantMsg("Checking the test outcome.", [
					["bash", { command: "npm test" }],
					["read", { file_path: "src/route.ts" }],
				]),
				resultMsg("bash", "all green", false, "c0"),
				resultMsg("read", "export const x", false, "c1"),
			]),
		);
		expect(digest.state).toContain("Previous step:");
		expect(digest.state).toContain("Checking the test outcome.");
		expect(digest.state).toContain('1. bash {"command":"npm test"}');
		expect(digest.state).toContain('2. read {"file_path":"src/route.ts"}');
		expect(digest.state).toContain("1. bash ok:\nall green");
		expect(digest.state).toContain("2. read ok:\nexport const x");
	});

	it("marks error results", async () => {
		const h = setup();
		const digest = h.recap.buildDigest(request([assistantMsg("", [["bash", { command: "npm test" }]]), resultMsg("bash", "boom", true, "c0")]));
		expect(digest.state).toContain("1. bash error:\nboom");
	});

	it("drops error result output last: long non-error output is truncated, the error marker stays", async () => {
		const h = setup({ recapTokens: 2000, stepTokens: 400 });
		const big = `HEAD-MARK${"a".repeat(8000)}TAIL-MARK`;
		const digest = h.recap.buildDigest(
			request([
				assistantMsg("STEP", [
					["bash", { command: "cmd" }],
					["read", { file_path: "f" }],
				]),
				resultMsg("bash", big, false, "c0"),
				resultMsg("read", "E-MARK failed", true, "c1"),
			]),
		);
		expect(digest.state).toContain("E-MARK failed");
		expect(digest.state).toContain("HEAD-MARK");
		expect(digest.state).toContain("TAIL-MARK");
		const step = digest.state.slice(digest.state.indexOf("Previous step:"));
		expect(tokens(step)).toBeLessThanOrEqual(400);
	});

	it("drops the step entirely when it cannot fit the budget", async () => {
		const h = setup({ recapTokens: 2000, stepTokens: 10 });
		const digest = h.recap.buildDigest(request([assistantMsg("a very long assistant text that will not fit", [["bash", { command: "npm test --very --long --args" }]]), resultMsg("bash", "out", false, "c0")]));
		expect(digest.state).not.toContain("Previous step:");
	});

	it("omits the block when the last message is not an assistant tool-calling step", async () => {
		const h = setup();
		for (const messages of [
			[assistantMsg("Checking.", [["bash", {}]]), resultMsg("bash", "out"), userMsg("next")],
			[assistantMsg("Done. All tests pass.", [])],
			[userMsg("hi")],
			[],
		]) {
			const text = h.recap.buildDigest(request(messages)).state;
			expect(text).not.toContain("Previous step:");
			expect(text).not.toContain("Checking.");
			expect(text).not.toContain("out");
			expect(text).not.toContain("Done. All tests pass.");
		}
	});

	it("pairs each result with its call, unordered results and nested calls included", async () => {
		const h = setup();
		const digest = h.recap.buildDigest(
			request([
				assistantMsg("", [
					["read", { file_path: "a" }],
					["read", { file_path: "b" }],
				]),
				resultMsg("read", "content of b", false, "c1"),
				resultMsg("read", "content of a", false, "c0"),
			]),
		);
		expect(digest.state).toContain('1. read {"file_path":"a"}');
		expect(digest.state).toContain("1. read ok:\ncontent of a");
		expect(digest.state).toContain('2. read {"file_path":"b"}');
		expect(digest.state).toContain("2. read ok:\ncontent of b");
	});

	it("serializes nested-call arguments compactly and truncates them", async () => {
		const h = setup();
		const digest = h.recap.buildDigest(
			request([
				assistantMsg("", [["bash", { command: `run ${"x".repeat(1000)}` }]]),
				resultMsg("bash", "done", false, "c0"),
			]),
		);
		const line = digest.state.split("\n").find((l) => l.startsWith("1. bash "));
		expect(line).toMatch(/^1\. bash \{"command":"run x+/);
		expect(line!.length).toBeLessThan(300);
	});

	it("leaves the step out when the caller asks for it", async () => {
		const h = setup();
		const req = request([assistantMsg("", [["bash", {}]]), resultMsg("bash", "stale output")]);
		expect(h.recap.buildDigest(req, { step: false }).state).not.toContain("stale output");
		expect(h.recap.buildDigest(req).state).toContain("stale output");
	});

	it("re-checks the Recap budget when building the Digest after the budget was lowered", async () => {
		const budgets = { recapTokens: 2000, stepTokens: 1200 };
		const h = setup(budgets);
		await h.write({ intent: "goal", courseOfAction: "plan" });
		for (let i = 0; i < 6; i++) await h.write({ event: `event-${i} ${"w".repeat(200)}` });
		expect(h.recap.buildDigest(request([])).state).toContain("event-0");
		budgets.recapTokens = 150;
		const { state } = h.recap.buildDigest(request([]));
		expect(tokens(state)).toBeLessThanOrEqual(150);
		expect(state).toContain("event-5");
		expect(state).not.toContain("event-0");
		expect(state).toContain("goal");
	});
});
