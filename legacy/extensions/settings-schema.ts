import type { PiAutoSettings, SandboxSettings } from "./types.ts";

export type PartialPiAutoSettings = Omit<Partial<PiAutoSettings>, "sandbox"> & {
	sandbox?: Partial<SandboxSettings>;
};

type Validation = (value: unknown) => boolean;

const enumValues = <T extends string>(values: readonly T[]): Validation => {
	const allowed = new Set<string>(values);
	return (value) => typeof value === "string" && allowed.has(value);
};
const isString = (value: unknown): value is string => typeof value === "string";
const isBoolean = (value: unknown): value is boolean => typeof value === "boolean";
const isNonNegativeNumber = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value) && value >= 0;
const isPositiveInteger = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 1;
const isNonNegativeInteger = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0;
const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every(isString);
const isStringMatrix = (value: unknown): value is string[][] => Array.isArray(value) && value.every(isStringArray);
const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const topLevelValidators: Record<Exclude<keyof PiAutoSettings, "sandbox">, Validation> = {
	reviewerProvider: isString,
	reviewerModel: isString,
	reviewerReasoning: enumValues(["auto", "off", "minimal", "low", "medium", "high", "xhigh", "max"]),
	fallbackToActiveModel: isBoolean,
	reviewerTimeoutMs: isNonNegativeNumber,
	maxConsecutiveDenialsPerTurn: isPositiveInteger,
	maxTotalDenialsPerTurn: isPositiveInteger,
	maxTranscriptEntries: isNonNegativeInteger,
	maxEntryChars: isNonNegativeInteger,
	maxTranscriptTotalChars: isNonNegativeInteger,
	maxPinnedRelatedEntries: isNonNegativeInteger,
	maxSummaryEntries: isNonNegativeInteger,
	enableDigest: isBoolean,
	useCodexAutoReview: isBoolean,
	sensitivePathPatterns: isStringArray,
	noticeLevel: enumValues(["silent", "denials", "normal", "verbose"]),
	customPolicy: isString,
	reviewerPolicySource: enumValues(["default", "codex-verbatim"]),
	extraSafeCommandPrefixes: isStringMatrix,
	stripAssistantText: isBoolean,
	stripToolResults: isBoolean,
};

const sandboxValidators: Record<keyof SandboxSettings, Validation> = {
	mode: enumValues(["off", "escape-only", "review-then-escape"]),
	allowedDomains: isStringArray,
	deniedDomains: isStringArray,
	disableDefaultNoProxy: isBoolean,
	allowRead: isStringArray,
	denyRead: isStringArray,
	allowWrite: isStringArray,
	denyWrite: isStringArray,
	reviewOnlyCommandPrefixes: isStringMatrix,
	allowedDangerousFiles: isStringArray,
	showStatusIndicator: isBoolean,
	annotateBashDisplay: isBoolean,
};

export interface ParsedSettings {
	settings: PartialPiAutoSettings;
	invalidFields: string[];
}

/** Parses persisted settings and omits malformed known fields so lower layers win. */
export function parsePartialSettings(value: unknown): ParsedSettings | undefined {
	if (!isRecord(value)) return undefined;
	const settings: PartialPiAutoSettings = {};
	const invalidFields: string[] = [];
	for (const [key, validate] of Object.entries(topLevelValidators) as [keyof typeof topLevelValidators, Validation][]) {
		if (!(key in value)) continue;
		if (validate(value[key])) (settings as Record<string, unknown>)[key] = value[key];
		else invalidFields.push(key);
	}
	if ("sandbox" in value) {
		if (!isRecord(value.sandbox)) invalidFields.push("sandbox");
		else {
			const sandbox: Partial<SandboxSettings> = {};
			for (const [key, validate] of Object.entries(sandboxValidators) as [keyof SandboxSettings, Validation][]) {
				if (!(key in value.sandbox)) continue;
				if (validate(value.sandbox[key])) (sandbox as Record<string, unknown>)[key] = value.sandbox[key];
				else invalidFields.push(`sandbox.${key}`);
			}
			if (Object.keys(sandbox).length > 0) settings.sandbox = sandbox;
		}
	}
	return { settings, invalidFields };
}
