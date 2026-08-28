/** Parsing and display helpers shared by settings field descriptors and UI views. */

export function formatCommandPrefix(prefix: readonly string[]): string {
	return prefix.map(formatCommandPrefixArg).join(" ");
}

function formatCommandPrefixArg(arg: string): string {
	if (/^[A-Za-z0-9_./:=@%+-]+$/.test(arg)) return arg;
	return `'${arg.replaceAll("'", `'\\''`)}'`;
}

export function parseStringListItemInput(raw: string): string {
	const item = raw.trim();
	if (item.length === 0) throw new Error("list item cannot be empty");
	return item;
}

/** Parse shell-word or JSON-array command-prefix input without executing it. */
export function parseCommandPrefixInput(raw: string): string[] {
	const trimmed = raw.trim();
	if (trimmed.length === 0) throw new Error("command prefix cannot be empty");
	if (trimmed.startsWith("[")) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch (err) {
			throw new Error(`invalid JSON command prefix: ${(err as Error).message}`);
		}
		if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string" || item.length === 0)) {
			throw new Error("JSON command prefix must be a non-empty array of non-empty strings");
		}
		if (parsed.length === 0) throw new Error("command prefix cannot be empty");
		return parsed;
	}

	const words: string[] = [];
	let current = "";
	let quote: "'" | '"' | null = null;
	let escaped = false;
	let sawTokenChars = false;
	for (const ch of trimmed) {
		if (escaped) {
			current += ch;
			escaped = false;
			sawTokenChars = true;
			continue;
		}
		if (ch === "\\") {
			escaped = true;
			sawTokenChars = true;
			continue;
		}
		if (quote) {
			if (ch === quote) quote = null;
			else {
				current += ch;
				sawTokenChars = true;
			}
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			sawTokenChars = true;
			continue;
		}
		if (/\s/.test(ch)) {
			if (sawTokenChars) {
				if (current.length === 0) throw new Error("command prefix arguments cannot be empty");
				words.push(current);
				current = "";
				sawTokenChars = false;
			}
			continue;
		}
		current += ch;
		sawTokenChars = true;
	}
	if (escaped) current += "\\";
	if (quote) throw new Error("unterminated quote in command prefix");
	if (sawTokenChars) {
		if (current.length === 0) throw new Error("command prefix arguments cannot be empty");
		words.push(current);
	}
	if (words.length === 0) throw new Error("command prefix cannot be empty");
	return words;
}

export function parseBool(raw: string): boolean {
	const lower = raw.trim().toLowerCase();
	if (lower === "true" || lower === "1" || lower === "yes" || lower === "on") return true;
	if (lower === "false" || lower === "0" || lower === "no" || lower === "off") return false;
	throw new Error(`expected a boolean (true/false), got "${raw}"`);
}

export function parseNumber(raw: string, opts: { min?: number; max?: number } = {}): number {
	const n = Number.parseFloat(raw.trim());
	if (Number.isNaN(n) || !Number.isFinite(n)) throw new Error(`expected a number, got "${raw}"`);
	if (opts.min !== undefined && n < opts.min) throw new Error(`value must be >= ${opts.min}`);
	if (opts.max !== undefined && n > opts.max) throw new Error(`value must be <= ${opts.max}`);
	return n;
}
