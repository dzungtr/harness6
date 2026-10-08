import type { ExtensionContext, ModelRoute, ModelRouteRequest } from "@earendil-works/pi-coding-agent";
import type { ConfigResult } from "./config.ts";

export type Router = (request: ModelRouteRequest, ctx: ExtensionContext) => Promise<ModelRoute>;

/**
 * Build the Virtual Model `route()`. This slice returns the `defaultRole` model for every request reason.
 * Only `model` and `thinkingLevel` are returned, so the system prompt and tool list never depend on the role.
 */
export function createRouter(getConfig: () => ConfigResult): Router {
	return async (request, ctx) => {
		const result = getConfig();
		if (!result.ok) throw new Error(`Dual Models config is invalid:\n${result.errors.join("\n")}`);
		const { config } = result;
		const ref = config.defaultRole === "deliberation" ? config.deliberationModel : config.executionModel;
		const slash = ref.indexOf("/");
		const model = ctx.modelRegistry.find(ref.slice(0, slash), ref.slice(slash + 1));
		if (!model) throw new Error(`Dual Models: model ${ref} is not in the Pi catalog`);
		return { model, thinkingLevel: request.thinkingLevel };
	};
}
