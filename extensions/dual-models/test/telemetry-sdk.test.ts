import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { trace } from "@opentelemetry/api";
import { describe, expect, it, vi } from "vitest";
import { shutdownTelemetry, startGateSpan } from "../src/telemetry.ts";

describe("dual_models.gate span without a registered provider", () => {
	it("starts the SDK, exports OTLP/HTTP to OTEL_EXPORTER_OTLP_ENDPOINT, service.name defaults to pi", async () => {
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
			startGateSpan({ event: "prompt", system1Model: "m", sessionId: "s1", previous: undefined, digestTokens: 1 }).end(
				{ ok: true, decision: { pDeliberation: 0.1, pExecution: 0.9 } },
				"execution",
			);
			await shutdownTelemetry();
			expect(posts).toHaveLength(1);
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
