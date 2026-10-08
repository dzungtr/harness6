import type { ModelRouteRequest } from "@earendil-works/pi-coding-agent";

/** Build the Digest sent to System-1 as `state`. Until the recap slice lands it is the last user prompt. */
export function buildDigest(request: ModelRouteRequest): string {
	for (let i = request.messages.length - 1; i >= 0; i--) {
		const m = request.messages[i];
		if (m.role !== "user") continue;
		if (typeof m.content === "string") return m.content;
		return m.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
	}
	return "";
}
