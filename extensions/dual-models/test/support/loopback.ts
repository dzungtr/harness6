import type { Server } from "node:http";

/**
 * The fake System-1 and OTLP servers listen on fixed loopback ports, one per test file, so a
 * sandbox profile can allowlist exactly this range instead of all of loopback. Bump a port here
 * when adding a file that binds a server; keep them contiguous.
 */
export const LOOPBACK_PORTS = {
	gate: 4399,
	turnEnd: 4400,
	telemetry: 4401,
	telemetrySdk: 4402,
	rpcE2e: 4403,
} as const;

/** Listen on `port`, with a message that explains a collision instead of a bare EADDRINUSE. */
export async function listenLoopback(server: Server, port: number): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		server.once("error", (error: NodeJS.ErrnoException) => {
			if (error.code !== "EADDRINUSE") return reject(error);
			reject(
				new Error(
					`port ${port} is already in use. The tests bind fixed loopback ports ${Object.values(LOOPBACK_PORTS).join(", ")} ` +
						`(see test/support/loopback.ts) so a sandbox profile can allowlist them; stop whatever holds the port.`,
				),
			);
		});
		server.listen(port, "127.0.0.1", () => resolve());
	});
}
