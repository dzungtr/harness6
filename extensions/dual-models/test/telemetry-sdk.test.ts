import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { trace } from "@opentelemetry/api";
import { describe, expect, it, vi } from "vitest";
import { flushTelemetry, startGateSpan } from "../src/telemetry.ts";

const ok = { ok: true, decision: { pReasoning: 0.1, pExecution: 0.9 } } as const;
const gate = () => startGateSpan({ event: "prompt", system1Model: "m", sessionId: "s1", previous: undefined, digestTokens: 1, criteriaHash: "abc123abc123" }).end(ok, "execution");

describe("dual_models.gate span without a registered provider", () => {
	it("starts the SDK, exports OTLP/HTTP with service.name pi, and survives repeated session_shutdown flushes", async () => {
		const posts: { url?: string; body: Buffer }[] = [];
		const server = createServer((req, res) => {
			const chunks: Buffer[] = [];
			req.on("data", (c) => chunks.push(c));
			req.on("end", () => {
				posts.push({ url: req.url, body: Buffer.concat(chunks) });
				res.writeHead(200, { "content-type": "application/json" });
				res.end("{}");
			});
		});
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
		vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
		vi.stubEnv("OTEL_SERVICE_NAME", "");
		try {
			gate();
			await flushTelemetry();
			gate();
			await flushTelemetry();
			expect(posts).toHaveLength(2);
			expect(posts[0].url).toBe("/v1/traces");
			const text = posts[0].body.toString("latin1");
			expect(text).toContain("dual_models.gate");
			expect(text).toContain("service.name");
			expect(text).toContain("pi");
		} finally {
			vi.unstubAllEnvs();
			trace.disable();
			server.closeAllConnections();
			await new Promise((r) => server.close(r));
		}
	});
});
