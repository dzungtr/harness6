import { estimateTokens } from "@earendil-works/pi-coding-agent";

export const countTokens = (text: string) => estimateTokens({ role: "user", content: text, timestamp: 0 } as never);

/** Keep the head and tail of `text` so the result stays within `budget` tokens. */
export function truncateHeadTail(text: string, budget: number): string {
	if (countTokens(text) <= budget) return text;
	const marker = "\n[... truncated ...]\n";
	const keep = Math.max(0, budget * 4 - marker.length - 4);
	const head = Math.ceil(keep / 2);
	const tail = Math.floor(keep / 2);
	return text.slice(0, head) + marker + (tail > 0 ? text.slice(-tail) : "");
}

/** Collapse runs of blank lines and trailing spaces, so whitespace does not spend the token budget. */
export function compact(text: string): string {
	return text
		.split("\n")
		.map((line) => line.trimEnd())
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}
