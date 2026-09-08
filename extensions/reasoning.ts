export type AutomaticReasoningLevel = "off" | "minimal";

export function automaticReasoningForModel(model: {
	thinkingLevelMap?: Partial<Record<string, string | null>>;
}): AutomaticReasoningLevel {
	return typeof model.thinkingLevelMap?.off === "string" ? "off" : "minimal";
}
