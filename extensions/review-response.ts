import type { AssessmentField, AssessmentValidationIssue, ReviewerAssessment } from "./types.ts";

const riskLevels = ["low", "medium", "high", "critical"];
const authorizations = ["high", "medium", "low", "unknown"];
const fields: AssessmentField[] = ["risk_level", "user_authorization", "evidence", "rationale"];

/** A portable strict schema; local validation retains size/nonempty checks too. */
export const ASSESSMENT_SCHEMA = {
	type: "object",
	properties: {
		risk_level: { type: "string", enum: riskLevels },
		user_authorization: { type: "string", enum: authorizations },
		evidence: { type: "array", items: { type: "string" } },
		rationale: { type: "string" },
	},
	required: fields,
	additionalProperties: false,
};

/** Called only for supported OpenAI Responses requests; never log this payload. */
export function constrainAssessmentPayload(payload: unknown): unknown {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Invalid OpenAI Responses request payload.");
	const value = payload as Record<string, unknown>;
	const text = value.text && typeof value.text === "object" && !Array.isArray(value.text) ? value.text : {};
	return { ...value, text: { ...text, format: { type: "json_schema", name: "pi_auto_assessment", strict: true, schema: ASSESSMENT_SCHEMA } } };
}

export type AssessmentValidation = { ok: true; assessment: ReviewerAssessment } | { ok: false; issue: AssessmentValidationIssue };

/** Diagnostics expose only expected field names/counts, never unknown keys or values. */
export function validateAssessment(text: string): AssessmentValidation {
	const invalid = (issue: AssessmentValidationIssue): AssessmentValidation => ({ ok: false, issue });
	if (!text.trim()) return invalid({ code: "empty_response" });
	let raw: unknown;
	try { raw = JSON.parse(text.trim().replace(/^```json\s*([\s\S]*?)\s*```$/i, "$1")); }
	catch { return invalid({ code: "invalid_json" }); }
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return invalid({ code: "not_object" });
	const value = raw as Record<string, unknown>;
	const missing = fields.filter((field) => !Object.hasOwn(value, field));
	if (missing.length) return invalid({ code: "missing_fields", missing });
	const extraFieldCount = Object.keys(value).filter((key) => !fields.includes(key as AssessmentField)).length;
	if (extraFieldCount) return invalid({ code: "unexpected_fields", extraFieldCount });
	const badField = (field: AssessmentField, rule: AssessmentValidationIssue["rule"]) => invalid({ code: "invalid_field", field, rule });
	if (typeof value.risk_level !== "string") return badField("risk_level", "type");
	if (!riskLevels.includes(value.risk_level)) return badField("risk_level", "enum");
	if (typeof value.user_authorization !== "string") return badField("user_authorization", "type");
	if (!authorizations.includes(value.user_authorization)) return badField("user_authorization", "enum");
	if (!Array.isArray(value.evidence)) return badField("evidence", "type");
	if (value.evidence.length > 32) return badField("evidence", "max_items");
	if (value.evidence.some((id) => typeof id !== "string")) return badField("evidence", "item_type");
	if (value.evidence.some((id: string) => !id.trim())) return badField("evidence", "item_empty");
	if (value.evidence.some((id: string) => id.length > 128)) return badField("evidence", "item_length");
	if (typeof value.rationale !== "string") return badField("rationale", "type");
	if (!value.rationale.trim()) return badField("rationale", "empty");
	if (value.rationale.length > 2000) return badField("rationale", "max_length");
	return { ok: true, assessment: { risk_level: value.risk_level as ReviewerAssessment["risk_level"], user_authorization: value.user_authorization as ReviewerAssessment["user_authorization"], evidence: value.evidence, rationale: value.rationale.trim() } };
}

/** Compatibility helper; invalid or incomplete output never supplies inferred scores. */
export function parseAssessment(text: string): ReviewerAssessment | undefined {
	const result = validateAssessment(text);
	return result.ok ? result.assessment : undefined;
}

export function describeValidation(issue: AssessmentValidationIssue): string {
	switch (issue.code) {
		case "empty_response": return "The reviewer returned no text.";
		case "invalid_json": return "The reviewer response is not complete JSON.";
		case "not_object": return "The reviewer response must be a JSON object.";
		case "missing_fields": return `Missing required fields: ${issue.missing!.join(", ")}.`;
		case "unexpected_fields": return `The reviewer returned ${issue.extraFieldCount} unexpected field(s).`;
		case "invalid_field": return `The reviewer returned an invalid ${issue.field} field (${issue.rule}).`;
		case "output_truncated": return "The reviewer hit the output-token limit before completing its assessment.";
	}
}
