import { estimateTokens } from "@earendil-works/pi-coding-agent";
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

function setup(budgets = { recapTokens: 2000, toolOutputTokens: 2000 }, restored: unknown[] = []): Harness {
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
	const ctx = { sessionManager: { getBranch: () => branch } };
	const fire = (name: string, event: unknown) => (handlers[name] ?? []).forEach((h) => h(event, ctx));
	fire("session_start", { type: "session_start", reason: "startup" });
	return { tool, entries, recap, fire, write: (params) => tool.execute("id", params, undefined, undefined, ctx) };
}

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
		const { state } = h.recap.buildDigest();
		expect(state).toContain("fix invoices");
		expect(state).toContain("step B");
		expect(state).not.toContain("fix billing");
		expect(state).not.toContain("step A");
	});

	it("keeps events FIFO within the budget, evicting the oldest", async () => {
		const h = setup({ recapTokens: 60, toolOutputTokens: 100 });
		await h.write({ intent: "i", courseOfAction: "c" });
		for (const n of [1, 2, 3, 4, 5, 6, 7, 8]) await h.write({ event: `event-${n} ${"x".repeat(40)}` });
		const { state } = h.recap.buildDigest();
		expect(state).toContain("event-8");
		expect(state).not.toContain("event-1 ");
		expect(tokens(state)).toBeLessThanOrEqual(60);
	});

	it("rejects an over-budget write with an error and leaves state unchanged", async () => {
		const h = setup({ recapTokens: 30, toolOutputTokens: 100 });
		await h.write({ intent: "short", courseOfAction: "plan" });
		const before = h.recap.buildDigest().state;
		const entriesBefore = h.entries.length;
		await expect(h.write({ intent: "y".repeat(400) })).rejects.toThrow(/budget/i);
		expect(h.recap.buildDigest().state).toBe(before);
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
		const { state } = resumed.recap.buildDigest();
		expect(state).toContain("ship feature");
		expect(state).toContain("step 1 done");
	});
});

describe("digest builder", () => {
	it("contains the recap and the last tool output but no role field", async () => {
		const h = setup();
		await h.write({ intent: "goal", courseOfAction: "plan" });
		h.fire("tool_result", { type: "tool_result", toolName: "bash", content: [{ type: "text", text: "all green" }] });
		const digest = h.recap.buildDigest();
		expect(digest.state).toContain("goal");
		expect(digest.state).toContain("all green");
		expect(digest.state).not.toMatch(/role|reasoning|execution/i);
		expect(digest.tokens).toBe(tokens(digest.state));
	});

	it("ignores the recap tool's own result as last tool output", () => {
		const h = setup();
		h.fire("tool_result", { type: "tool_result", toolName: "bash", content: [{ type: "text", text: "real output" }] });
		h.fire("tool_result", { type: "tool_result", toolName: "recap", content: [{ type: "text", text: "recap saved" }] });
		expect(h.recap.buildDigest().state).toContain("real output");
	});

	it("truncates a large tool output head + tail to its budget", () => {
		const h = setup({ recapTokens: 2000, toolOutputTokens: 50 });
		const big = `HEAD-MARK${"a".repeat(5000)}TAIL-MARK`;
		h.fire("tool_result", { type: "tool_result", toolName: "bash", content: [{ type: "text", text: big }] });
		const { state } = h.recap.buildDigest();
		expect(state).toContain("HEAD-MARK");
		expect(state).toContain("TAIL-MARK");
		expect(state.length).toBeLessThan(big.length);
		expect(tokens(state.slice(state.indexOf("HEAD-MARK")))).toBeLessThanOrEqual(50);
	});

	it("keeps a small tool output intact", () => {
		const h = setup();
		h.fire("tool_result", { type: "tool_result", toolName: "bash", content: [{ type: "text", text: "tiny" }] });
		expect(h.recap.buildDigest().state).toContain("tiny");
	});

	it("can leave the last tool output out of the Digest", () => {
		const h = setup();
		h.fire("tool_result", { type: "tool_result", toolName: "bash", content: [{ type: "text", text: "stale output" }] });
		expect(h.recap.buildDigest({ toolOutput: false }).state).not.toContain("stale output");
		expect(h.recap.buildDigest().state).toContain("stale output");
	});

	it("drops the previous branch's tool output when the branch is restored", () => {
		const h = setup();
		h.fire("tool_result", { type: "tool_result", toolName: "bash", content: [{ type: "text", text: "old branch output" }] });
		h.fire("session_tree", { type: "session_tree" });
		expect(h.recap.buildDigest().state).not.toContain("old branch output");
		h.fire("tool_result", { type: "tool_result", toolName: "bash", content: [{ type: "text", text: "second" }] });
		h.fire("session_start", { type: "session_start", reason: "resume" });
		expect(h.recap.buildDigest().state).not.toContain("second");
	});

	it("re-checks the Recap budget when building the Digest after the budget was lowered", async () => {
		const budgets = { recapTokens: 2000, toolOutputTokens: 2000 };
		const h = setup(budgets);
		await h.write({ intent: "goal", courseOfAction: "plan" });
		for (let i = 0; i < 6; i++) await h.write({ event: `event-${i} ${"w".repeat(200)}` });
		expect(h.recap.buildDigest().state).toContain("event-0");
		budgets.recapTokens = 150;
		const { state } = h.recap.buildDigest();
		expect(tokens(state)).toBeLessThanOrEqual(150);
		expect(state).toContain("event-5");
		expect(state).not.toContain("event-0");
		expect(state).toContain("goal");
	});
});
