import { type Span, SpanStatusCode, type Tracer, trace } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import type { Role } from "./config.ts";
import type { DecideResult } from "./system1.ts";

let tracer: Tracer | undefined;
let ownProvider: NodeTracerProvider | undefined;

/**
 * Use the global tracer provider if one is registered, otherwise start our own SDK (OTLP/HTTP, configured
 * from `OTEL_EXPORTER_OTLP_*`). pi-otel keeps a private provider, so normally we become the global one.
 */
function getTracer(): Tracer {
	if (tracer) return tracer;
	const provider = new NodeTracerProvider({
		resource: resourceFromAttributes({ "service.name": process.env.OTEL_SERVICE_NAME || "pi" }),
		spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter())],
	});
	if (trace.setGlobalTracerProvider(provider)) {
		ownProvider = provider;
	} else {
		void provider.shutdown();
	}
	tracer = trace.getTracer("dual-models");
	return tracer;
}

/** Flush the SDK we started, if any, and keep it alive: Pi fires session_shutdown on /new, /resume and /fork. */
export async function flushTelemetry(): Promise<void> {
	await ownProvider?.forceFlush();
}

export interface GateSpanStart {
	event: string;
	system1Model: string;
	sessionId: string;
	previous: Role | undefined;
	digestTokens: number;
	criteriaHash: string;
	/** Configured `provider/modelId` per role, from `models.<role>.model`. */
	models: Record<Role, string>;
}

export interface GateSpan {
	/** End the span; its duration is the System-1 round-trip. */
	end(outcome: DecideResult, chosen: Role): void;
}

/** Start a `dual_models.gate` span. `session.id` and `gen_ai.conversation.id` match what `@b1tank/pi-otel` emits. */
export function startGateSpan(start: GateSpanStart): GateSpan {
	const span: Span = getTracer().startSpan("dual_models.gate", {
		attributes: {
			event: start.event,
			"system1.model": start.system1Model,
			"role.previous": start.previous ?? "none",
			"model.previous": start.previous ? start.models[start.previous] : "none",
			"digest.tokens": start.digestTokens,
			"gate.criteria_hash": start.criteriaHash,
			"session.id": start.sessionId,
			"gen_ai.conversation.id": start.sessionId,
		},
	});
	return {
		end(outcome, chosen) {
			span.setAttributes({
				"role.chosen": chosen,
				"model.applied": start.models[chosen],
				switched: start.previous !== undefined && start.previous !== chosen,
				fallback: !outcome.ok,
			});
			if (outcome.ok) {
				span.setAttributes({ "p.reasoning": outcome.decision.pReasoning, "p.execution": outcome.decision.pExecution });
			} else {
				span.setStatus({ code: SpanStatusCode.ERROR, message: outcome.detail ? `${outcome.failure}: ${outcome.detail}` : outcome.failure });
			}
			span.end();
		},
	};
}

export interface RecapSpanStart {
	sessionId: string;
	budget: number;
}

export interface RecapWrite {
	intent: string;
	courseOfAction: string;
	/** The event appended by this write, if any. */
	event?: string;
	eventCount: number;
	tokens: number;
}

/** Record a `dual_models.recap` span for one `recap` tool call: the stored Recap on success, an error status when the write is rejected. */
export function recordRecapSpan(start: RecapSpanStart, write: RecapWrite | Error): void {
	const span: Span = getTracer().startSpan("dual_models.recap", {
		attributes: { "recap.budget": start.budget, "session.id": start.sessionId, "gen_ai.conversation.id": start.sessionId },
	});
	if (write instanceof Error) {
		span.setAttribute("recap.rejected", true);
		span.setStatus({ code: SpanStatusCode.ERROR, message: write.message });
	} else {
		span.setAttributes({
			"recap.rejected": false,
			"recap.tokens": write.tokens,
			"recap.intent": write.intent,
			"recap.course_of_action": write.courseOfAction,
			"recap.events.count": write.eventCount,
		});
		if (write.event !== undefined) span.setAttribute("recap.event", write.event);
	}
	span.end();
}
