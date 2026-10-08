import { SpanStatusCode, trace } from "@opentelemetry/api";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { registerRecap } from "../src/recap.ts";

const exporter = new InMemorySpanExporter();

function setup(recapTokens = 2000) {
	let tool: any;
	const pi = { on: () => {}, registerTool: (t: unknown) => void (tool = t), appendEntry: () => {} };
	registerRecap(pi as never, () => ({ recapTokens, toolOutputTokens: 2000 }));
	const ctx = { sessionManager: { getBranch: () => [], getSessionId: () => "sess-42" } };
	return (params: Record<string, string>) => tool.execute("id", params, undefined, undefined, ctx);
}

beforeAll(() => {
	expect(trace.setGlobalTracerProvider(new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }))).toBe(true);
});
beforeEach(() => exporter.reset());

describe("dual_models.recap span", () => {
	it("emits one span per stored write with the resulting Recap", async () => {
		const write = setup();
		await write({ intent: "fix billing", courseOfAction: "step A" });
		await write({ event: "tests green" });
		const [first, second] = exporter.getFinishedSpans();
		expect(first.name).toBe("dual_models.recap");
		expect(first.attributes).toEqual({
			"recap.budget": 2000,
			"recap.rejected": false,
			"recap.tokens": expect.any(Number),
			"recap.intent": "fix billing",
			"recap.course_of_action": "step A",
			"recap.events.count": 0,
			"session.id": "sess-42",
			"gen_ai.conversation.id": "sess-42",
		});
		expect(second.attributes["recap.event"]).toBe("tests green");
		expect(second.attributes["recap.events.count"]).toBe(1);
		expect(second.attributes["recap.intent"]).toBe("fix billing");
	});

	it("marks an over-budget write as rejected with an error status", async () => {
		const write = setup(5);
		await expect(write({ intent: "x ".repeat(200), courseOfAction: "y ".repeat(200) })).rejects.toThrow(/rejected/);
		const [span] = exporter.getFinishedSpans();
		expect(span.attributes["recap.rejected"]).toBe(true);
		expect(span.attributes["recap.intent"]).toBeUndefined();
		expect(span.status.code).toBe(SpanStatusCode.ERROR);
	});

	it("marks an empty write as rejected", async () => {
		await expect(setup()({})).rejects.toThrow(/provide at least one/);
		expect(exporter.getFinishedSpans()[0].attributes["recap.rejected"]).toBe(true);
	});
});
