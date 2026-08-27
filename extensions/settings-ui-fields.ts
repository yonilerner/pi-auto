/** Focused field catalog and typed accessors for the settings UI. */

import {
	formatCommandPrefix,
	parseBool,
	parseCommandPrefixInput,
	parseNumber,
	parseStringListItemInput,
} from "./settings-field-codecs.ts";
import type { PartialPiAutoSettings } from "./settings-store.ts";
import type { PiAutoSettings, SandboxSettings } from "./types.ts";

/**
 * Layers a user can edit in the UI. ("default" and "env" are read-only.)
 */
export type EditableLayer = "user-global" | "per-project";

/**
 * Field descriptor. Each settings field that's editable from the UI has one.
 * The descriptor encapsulates display, validation, and how to splice the
 * change back into the typed settings shape (so the UI doesn't need to
 * special-case nested fields like `sandbox.mode`).
 */
export interface BaseFieldDescriptor {
	/** Unique row id; can use dotted form for nested fields ("sandbox.mode"). */
	id: string;
	label: string;
	help?: string;
	/** Read the current effective display value as a string. */
	read: (settings: PiAutoSettings) => string;
	/**
	 * For the layer attribution: which top-level PiAutoSettings field does
	 * this descriptor's value live under? Nested sandbox fields all map to
	 * "sandbox", so toggling any sub-field shows the sandbox layer.
	 */
	settingsKey: keyof PiAutoSettings;
}

export interface ScalarFieldDescriptor extends BaseFieldDescriptor {
	kind: "bool" | "string" | "number" | "enum";
	enumValues?: readonly string[];
	/**
	 * Given the current effective settings and a raw user-entered string,
	 * compute the new value to persist under settingsKey.
	 */
	applyChange: (
		settings: PiAutoSettings,
		raw: string,
	) => PiAutoSettings[keyof PiAutoSettings];
}

export interface ArrayAccess<T> {
	/** Pluck the effective array out of merged settings. */
	getEffective: (settings: PiAutoSettings) => readonly T[];
	/** Pluck this field's explicit value out of a partial settings JSON. */
	readPartial: (partial: PartialPiAutoSettings) => readonly T[] | undefined;
	/** Persist this field back into a partial settings JSON. */
	writePartial: (partial: PartialPiAutoSettings, value: T[]) => void;
	/** Render one item for the list row and notifications. */
	renderItem: (item: T) => string;
	/** Parse the add-item prompt into the typed array item. */
	parseInput: (raw: string) => T;
}

export interface ArrayFieldBase<T> extends BaseFieldDescriptor {
	arrayAccess: ArrayAccess<T>;
}

export interface StringListFieldDescriptor extends ArrayFieldBase<string> {
	kind: "stringList";
}

export interface CommandPrefixListFieldDescriptor extends ArrayFieldBase<string[]> {
	kind: "commandPrefixList";
}

export type ArrayFieldDescriptor<T> = ArrayFieldBase<T> & {
	kind: "stringList" | "commandPrefixList";
};

export type FieldDescriptor = ScalarFieldDescriptor | StringListFieldDescriptor | CommandPrefixListFieldDescriptor;

/**
 * Helper: render the layer-attribution display value for a list-typed
 * field. "(empty)" for [], otherwise "<n> items".
 */
export function renderListSummary(items: readonly unknown[], itemName = "item"): string {
	return items.length === 0 ? "(empty)" : `${items.length} ${itemName}${items.length === 1 ? "" : "s"}`;
}

type StringArraySandboxKey = {
	[K in keyof SandboxSettings]: SandboxSettings[K] extends string[] ? K : never;
}[keyof SandboxSettings];

function writeSandboxPartial(
	partial: PartialPiAutoSettings,
	patch: Partial<SandboxSettings>,
): void {
	partial.sandbox = { ...(partial.sandbox ?? {}), ...patch };
}

/**
 * Build the `sandbox` array-access helpers. All seven sandbox arrays share
 * the same read/write shape; factoring this out keeps the descriptor table
 * below readable.
 */
function sandboxArrayAccess<K extends StringArraySandboxKey>(key: K): ArrayAccess<string> {
	return {
		getEffective: (s) => s.sandbox[key],
		readPartial: (p) => p.sandbox?.[key],
		writePartial: (p, v) => writeSandboxPartial(p, { [key]: v }),
		renderItem: (item) => item,
		parseInput: parseStringListItemInput,
	};
}

function extraSafeCommandPrefixesArrayAccess(): ArrayAccess<string[]> {
	return {
		getEffective: (s) => s.extraSafeCommandPrefixes,
		readPartial: (p) => p.extraSafeCommandPrefixes,
		writePartial: (p, v) => {
			p.extraSafeCommandPrefixes = v;
		},
		renderItem: formatCommandPrefix,
		parseInput: parseCommandPrefixInput,
	};
}

function reviewOnlyCommandPrefixesArrayAccess(): ArrayAccess<string[]> {
	return {
		getEffective: (s) => s.sandbox.reviewOnlyCommandPrefixes,
		readPartial: (p) => p.sandbox?.reviewOnlyCommandPrefixes,
		writePartial: (p, v) => writeSandboxPartial(p, { reviewOnlyCommandPrefixes: v }),
		renderItem: formatCommandPrefix,
		parseInput: parseCommandPrefixInput,
	};
}

export const FIELDS: FieldDescriptor[] = [
	// Reviewer model
	{
		id: "reviewerProvider",
		label: "Reviewer provider",
		help: "Provider id used to look up the reviewer model in pi's ModelRegistry.",
		kind: "string",
		settingsKey: "reviewerProvider",
		read: (s) => s.reviewerProvider,
		applyChange: (_s, raw) => raw.trim(),
	},
	{
		id: "reviewerModel",
		label: "Reviewer model",
		help: "Model id used for the review call (e.g. gpt-5-mini, claude-haiku-4-5).",
		kind: "string",
		settingsKey: "reviewerModel",
		read: (s) => s.reviewerModel,
		applyChange: (_s, raw) => raw.trim(),
	},
	{
		id: "reviewerReasoning",
		label: "Reviewer reasoning effort",
		help: "auto = pi-auto picks (low for codex-auto-review, minimal otherwise). Override when the model doesn't accept the default — e.g. gpt-5.6-luna returns empty responses at minimal.",
		kind: "enum",
		enumValues: ["auto", "off", "minimal", "low", "medium", "high", "xhigh", "max"],
		settingsKey: "reviewerReasoning",
		read: (s) => s.reviewerReasoning,
		applyChange: (_s, raw) => {
			const allowed = ["auto", "off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
			if (!(allowed as readonly string[]).includes(raw)) {
				throw new Error(`reviewerReasoning must be one of: ${allowed.join(", ")}`);
			}
			return raw as (typeof allowed)[number];
		},
	},
	{
		id: "fallbackToActiveModel",
		label: "Fall back to active model",
		help: "If reviewer model unavailable, use the session's current model.",
		kind: "bool",
		settingsKey: "fallbackToActiveModel",
		read: (s) => String(s.fallbackToActiveModel),
		applyChange: (_s, raw) => parseBool(raw),
	},
	{
		id: "useCodexAutoReview",
		label: "Use codex-auto-review model",
		help: "Use OpenAI's hidden codex-auto-review fine-tune instead of reviewerModel.",
		kind: "bool",
		settingsKey: "useCodexAutoReview",
		read: (s) => String(s.useCodexAutoReview),
		applyChange: (_s, raw) => parseBool(raw),
	},
	{
		id: "reviewerPolicySource",
		label: "Reviewer policy source",
		help: "default = our tuned policy; codex-verbatim = codex's policy template (benchmarks only).",
		kind: "enum",
		enumValues: ["default", "codex-verbatim"],
		settingsKey: "reviewerPolicySource",
		read: (s) => s.reviewerPolicySource,
		applyChange: (_s, raw) => {
			if (raw !== "default" && raw !== "codex-verbatim") {
				throw new Error(`reviewerPolicySource must be "default" or "codex-verbatim"`);
			}
			return raw;
		},
	},
	{
		id: "reviewerTimeoutMs",
		label: "Reviewer timeout (ms)",
		kind: "number",
		settingsKey: "reviewerTimeoutMs",
		read: (s) => String(s.reviewerTimeoutMs),
		applyChange: (_s, raw) => parseNumber(raw, { min: 500 }),
	},

	// Transcript shaping
	{
		id: "maxTranscriptEntries",
		label: "Transcript entry cap",
		kind: "number",
		settingsKey: "maxTranscriptEntries",
		read: (s) => String(s.maxTranscriptEntries),
		applyChange: (_s, raw) => parseNumber(raw, { min: 1 }),
	},
	{
		id: "maxEntryChars",
		label: "Per-entry char cap",
		kind: "number",
		settingsKey: "maxEntryChars",
		read: (s) => String(s.maxEntryChars),
		applyChange: (_s, raw) => parseNumber(raw, { min: 100 }),
	},
	{
		id: "maxTranscriptTotalChars",
		label: "Total transcript char cap",
		kind: "number",
		settingsKey: "maxTranscriptTotalChars",
		read: (s) => String(s.maxTranscriptTotalChars),
		applyChange: (_s, raw) => parseNumber(raw, { min: 1_000 }),
	},
	{
		id: "maxPinnedRelatedEntries",
		label: "Max pinned related entries",
		kind: "number",
		settingsKey: "maxPinnedRelatedEntries",
		read: (s) => String(s.maxPinnedRelatedEntries),
		applyChange: (_s, raw) => parseNumber(raw, { min: 0 }),
	},
	{
		id: "maxSummaryEntries",
		label: "Max summary entries",
		kind: "number",
		settingsKey: "maxSummaryEntries",
		read: (s) => String(s.maxSummaryEntries),
		applyChange: (_s, raw) => parseNumber(raw, { min: 0 }),
	},
	{
		id: "enableDigest",
		label: "Enable rolling auth digest",
		kind: "bool",
		settingsKey: "enableDigest",
		read: (s) => String(s.enableDigest),
		applyChange: (_s, raw) => parseBool(raw),
	},
	{
		id: "stripAssistantText",
		label: "Strip assistant text from transcript",
		help: "Defend against assistant-narrated authorization claims.",
		kind: "bool",
		settingsKey: "stripAssistantText",
		read: (s) => String(s.stripAssistantText),
		applyChange: (_s, raw) => parseBool(raw),
	},
	{
		id: "stripToolResults",
		label: "Strip tool results from transcript",
		help: "Defend against prompt injection via tool output.",
		kind: "bool",
		settingsKey: "stripToolResults",
		read: (s) => String(s.stripToolResults),
		applyChange: (_s, raw) => parseBool(raw),
	},

	// Notifications & circuit breaker
	{
		id: "noticeLevel",
		label: "Inline notice level",
		help: "silent / denials / normal / verbose. Critical posture warnings always show regardless.",
		kind: "enum",
		enumValues: ["silent", "denials", "normal", "verbose"],
		settingsKey: "noticeLevel",
		read: (s) => s.noticeLevel,
		applyChange: (_s, raw) => {
			if (raw !== "silent" && raw !== "denials" && raw !== "normal" && raw !== "verbose") {
				throw new Error(`noticeLevel must be one of silent / denials / normal / verbose`);
			}
			return raw;
		},
	},
	{
		id: "maxConsecutiveDenialsPerTurn",
		label: "Consecutive denials per turn before tripping",
		kind: "number",
		settingsKey: "maxConsecutiveDenialsPerTurn",
		read: (s) => String(s.maxConsecutiveDenialsPerTurn),
		applyChange: (_s, raw) => parseNumber(raw, { min: 1 }),
	},
	{
		id: "maxTotalDenialsPerTurn",
		label: "Total denials per turn before tripping",
		kind: "number",
		settingsKey: "maxTotalDenialsPerTurn",
		read: (s) => String(s.maxTotalDenialsPerTurn),
		applyChange: (_s, raw) => parseNumber(raw, { min: 1 }),
	},

	// Sandbox sub-fields
	{
		id: "sandbox.mode",
		label: "Sandbox mode",
		kind: "enum",
		enumValues: ["off", "escape-only", "review-then-escape"],
		settingsKey: "sandbox",
		read: (s) => s.sandbox.mode,
		applyChange: (s, raw) => {
			if (raw !== "off" && raw !== "escape-only" && raw !== "review-then-escape") {
				throw new Error(`sandbox.mode must be "off", "escape-only", or "review-then-escape"`);
			}
			return { ...s.sandbox, mode: raw } satisfies SandboxSettings;
		},
	},
	{
		id: "sandbox.disableDefaultNoProxy",
		label: "Sandbox: disable default NO_PROXY",
		help: "Do not inject ASRT's default NO_PROXY/no_proxy bypass for loopback, .local, link-local, and private ranges.",
		kind: "bool",
		settingsKey: "sandbox",
		read: (s) => String(s.sandbox.disableDefaultNoProxy),
		applyChange: (s, raw) => ({ ...s.sandbox, disableDefaultNoProxy: parseBool(raw) }),
	},
	{
		id: "sandbox.showStatusIndicator",
		label: "Sandbox: status-bar indicator",
		kind: "bool",
		settingsKey: "sandbox",
		read: (s) => String(s.sandbox.showStatusIndicator),
		applyChange: (s, raw) => ({ ...s.sandbox, showStatusIndicator: parseBool(raw) }),
	},
	{
		id: "sandbox.annotateBashDisplay",
		label: "Sandbox: annotate bash display",
		kind: "bool",
		settingsKey: "sandbox",
		read: (s) => String(s.sandbox.annotateBashDisplay),
		applyChange: (s, raw) => ({ ...s.sandbox, annotateBashDisplay: parseBool(raw) }),
	},

	// ---- string[] list fields ---------------------------------------
	// Edited via the dedicated list view (add/remove). The per-project layer
	// follows the copy-inherited-on-first-add rule from nextArrayForAppend.
	{
		id: "sensitivePathPatterns",
		label: "Sensitive path patterns",
		help: "Substring patterns whose reads are reviewed even inside cwd.",
		kind: "stringList",
		settingsKey: "sensitivePathPatterns",
		read: (s) => renderListSummary(s.sensitivePathPatterns),
		arrayAccess: {
			getEffective: (s) => s.sensitivePathPatterns,
			readPartial: (p) => p.sensitivePathPatterns,
			writePartial: (p, v) => {
				p.sensitivePathPatterns = v;
			},
			renderItem: (item) => item,
			parseInput: parseStringListItemInput,
		},
	},
	{
		id: "extraSafeCommandPrefixes",
		label: "Extra safe command prefixes",
		help: "Argv prefixes that bypass review for bash. Add as shell words (e.g. npm test) or JSON array.",
		kind: "commandPrefixList",
		settingsKey: "extraSafeCommandPrefixes",
		read: (s) => renderListSummary(s.extraSafeCommandPrefixes, "prefix"),
		arrayAccess: extraSafeCommandPrefixesArrayAccess(),
	},
	{
		id: "sandbox.reviewOnlyCommandPrefixes",
		label: "Sandbox: review-only command prefixes",
		help: "Argv prefixes that skip sandboxing and run only after reviewer approval. Add as shell words (e.g. gh) or JSON array.",
		kind: "commandPrefixList",
		settingsKey: "sandbox",
		read: (s) => renderListSummary(s.sandbox.reviewOnlyCommandPrefixes, "prefix"),
		arrayAccess: reviewOnlyCommandPrefixesArrayAccess(),
	},
	{
		id: "sandbox.allowedDomains",
		label: "Sandbox: allowed domains",
		help: "Network destinations the sandbox may reach. `*.example.com` wildcards OK.",
		kind: "stringList",
		settingsKey: "sandbox",
		read: (s) => renderListSummary(s.sandbox.allowedDomains),
		arrayAccess: sandboxArrayAccess("allowedDomains"),
	},
	{
		id: "sandbox.deniedDomains",
		label: "Sandbox: denied domains",
		help: "Hard-deny network destinations. Checked before allowedDomains.",
		kind: "stringList",
		settingsKey: "sandbox",
		read: (s) => renderListSummary(s.sandbox.deniedDomains),
		arrayAccess: sandboxArrayAccess("deniedDomains"),
	},
	{
		id: "sandbox.allowRead",
		label: "Sandbox: allow read",
		help: "Extra filesystem paths the sandbox may read.",
		kind: "stringList",
		settingsKey: "sandbox",
		read: (s) => renderListSummary(s.sandbox.allowRead),
		arrayAccess: sandboxArrayAccess("allowRead"),
	},
	{
		id: "sandbox.denyRead",
		label: "Sandbox: deny read",
		help: "Extra filesystem paths the sandbox is forbidden from reading.",
		kind: "stringList",
		settingsKey: "sandbox",
		read: (s) => renderListSummary(s.sandbox.denyRead),
		arrayAccess: sandboxArrayAccess("denyRead"),
	},
	{
		id: "sandbox.allowWrite",
		label: "Sandbox: allow write",
		help: "Filesystem paths the sandbox may write. Default `.` = workspace.",
		kind: "stringList",
		settingsKey: "sandbox",
		read: (s) => renderListSummary(s.sandbox.allowWrite),
		arrayAccess: sandboxArrayAccess("allowWrite"),
	},
	{
		id: "sandbox.denyWrite",
		label: "Sandbox: deny write",
		help: "Hard-deny filesystem write paths even inside allowWrite roots.",
		kind: "stringList",
		settingsKey: "sandbox",
		read: (s) => renderListSummary(s.sandbox.denyWrite),
		arrayAccess: sandboxArrayAccess("denyWrite"),
	},
	{
		id: "sandbox.allowedDangerousFiles",
		label: "Sandbox: allowed dangerous files",
		help: "ASRT DANGEROUS_FILES entries to drop (e.g. .gitmodules). Read the type doc first.",
		kind: "stringList",
		settingsKey: "sandbox",
		read: (s) => renderListSummary(s.sandbox.allowedDangerousFiles),
		arrayAccess: sandboxArrayAccess("allowedDangerousFiles"),
	},
];
