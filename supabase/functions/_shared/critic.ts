/**
 * Deterministic extractive-claim critic and attempt evaluation (PLAN.md s.2 and s.4).
 *
 * It checks extraction, date admission and provenance against the frozen PromptEvidence array.
 * It does not check article truth, semantic entailment of a larger argument or training memory.
 * Any invalid attached claim withholds the whole research probability; failed claims are never
 * removed so a probability derived from them could still be scored.
 */

import { isStorableText } from "./canonical.ts";
import type { PromptEvidence, SourceDecision } from "./evidence.ts";
import { LIMITS, type ModelArm } from "./manifest.ts";
import type { StructuralCode, StructuralFeedback } from "./prompt.ts";

export const CLAIM_TEXT_MAX = 4000;
export const CLAIM_REF_MAX = 200;

export type ModelClaim = { text: string; evidenceId: string; start: number; end: number; contentHash: string };

export type ParsedOutput = { probability: number; rationale: string; claims: ModelClaim[] };

export type ClaimDecision = ModelClaim & { claimIndex: number; verdict: "supported" | StructuralCode };

export type AttemptEvaluation =
  | { status: "valid"; probability: number; rationale: string; claims: ClaimDecision[] }
  | {
      status: "withheld";
      probability: number;
      rationale: string;
      claims: ClaimDecision[];
      feedback: StructuralFeedback[];
      /** Structural claim failures may get one correction. */
      correctable: boolean;
      reason: string;
    }
  | { status: "failed"; code: string; detail: string };

/** Strict parse of the model JSON. Returns a failure code instead of guessing. */
export function parseModelOutput(text: string, arm: ModelArm): { ok: true; value: ParsedOutput } | { ok: false; code: string; detail: string } {
  if (text.length > LIMITS.providerResponseBytes) return { ok: false, code: "response_too_large", detail: "Model text exceeds the response bound." };
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  const body = fenced != null ? fenced[1] : trimmed;
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return { ok: false, code: "schema_invalid", detail: "Output is not a single JSON object." };
  }
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, code: "schema_invalid", detail: "Output is not a JSON object." };
  }
  const record = value as Record<string, unknown>;
  const probability = record.probability;
  if (typeof probability !== "number" || !Number.isFinite(probability) || probability < 0 || probability > 1) {
    return { ok: false, code: "schema_invalid", detail: "probability must be a finite number in [0, 1]." };
  }
  if (typeof record.rationale !== "string" || record.rationale.length > LIMITS.rationaleChars || !isStorableText(record.rationale)) {
    return { ok: false, code: "schema_invalid", detail: `rationale must be a string of at most ${LIMITS.rationaleChars} characters.` };
  }
  if (!Array.isArray(record.claims) || record.claims.length > LIMITS.claimsMax) {
    return { ok: false, code: "schema_invalid", detail: `claims must be an array of at most ${LIMITS.claimsMax}.` };
  }
  if (arm === "no_research" && record.claims.length > 0) {
    return { ok: false, code: "schema_invalid", detail: "The no-research arm must return an empty claims array." };
  }
  const claims: ModelClaim[] = [];
  for (const item of record.claims) {
    if (item == null || typeof item !== "object") return { ok: false, code: "schema_invalid", detail: "Each claim must be an object." };
    const c = item as Record<string, unknown>;
    if (
      typeof c.text !== "string" ||
      typeof c.evidenceId !== "string" ||
      typeof c.start !== "number" ||
      typeof c.end !== "number" ||
      typeof c.contentHash !== "string"
    ) {
      return { ok: false, code: "schema_invalid", detail: "Each claim needs text, evidenceId, start, end and contentHash." };
    }
    // Bounds match the database checks so an oversized untrusted value is a recorded schema failure,
    // never a write error after a paid call.
    if (c.text.length > CLAIM_TEXT_MAX || c.evidenceId.length > CLAIM_REF_MAX || c.contentHash.length > CLAIM_REF_MAX || !Number.isFinite(c.start) || !Number.isFinite(c.end) || ![c.text, c.evidenceId, c.contentHash].every(isStorableText)) {
      return { ok: false, code: "schema_invalid", detail: `Claim text must be <= ${CLAIM_TEXT_MAX} characters and references <= ${CLAIM_REF_MAX}.` };
    }
    claims.push({ text: c.text, evidenceId: c.evidenceId, start: c.start, end: c.end, contentHash: c.contentHash });
  }
  return { ok: true, value: { probability, rationale: record.rationale, claims } };
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** True when a UTF-16 index falls between the two halves of a surrogate pair. */
export function splitsSurrogate(text: string, index: number): boolean {
  if (index <= 0 || index >= text.length) return false;
  return isHighSurrogate(text.charCodeAt(index - 1)) && isLowSurrogate(text.charCodeAt(index));
}

/**
 * Verify one claim. Order: empty text, reference (unknown / truncated away), hash, offsets, span.
 * Rejected or wrong-question sources report unknown_source so feedback reveals nothing about them.
 */
export function verifyClaim(
  claim: ModelClaim,
  promptEvidence: readonly PromptEvidence[],
  ledger: readonly SourceDecision[],
  fullExcerptLength: (evidenceId: string) => number | null,
): "supported" | StructuralCode {
  if (claim.text.trim() === "") return "empty";
  const item = promptEvidence.find((e) => e.evidenceId === claim.evidenceId);
  if (item == null) {
    const decision = ledger.find((d) => d.evidenceId === claim.evidenceId);
    return decision?.decision === "over_cap" ? "truncated_away" : "unknown_source";
  }
  if (claim.contentHash !== item.excerptHash) return "hash_mismatch";
  const { start, end } = claim;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start) return "invalid_offset";
  if (end > item.excerpt.length) {
    const full = fullExcerptLength(item.evidenceId);
    return item.truncated && full != null && end <= full ? "truncated_away" : "invalid_offset";
  }
  if (splitsSurrogate(item.excerpt, start) || splitsSurrogate(item.excerpt, end)) return "invalid_offset";
  return item.excerpt.slice(start, end) === claim.text ? "supported" : "span_not_in_excerpt";
}

/**
 * Evaluate one model output for one arm against the frozen evidence pack.
 * Research needs 1..16 claims, all supported. No-research returns zero claims.
 */
export function evaluateOutput(
  text: string,
  arm: ModelArm,
  promptEvidence: readonly PromptEvidence[],
  ledger: readonly SourceDecision[],
  fullExcerptLength: (evidenceId: string) => number | null,
): AttemptEvaluation {
  const parsed = parseModelOutput(text, arm);
  if (!parsed.ok) return { status: "failed", code: parsed.code, detail: parsed.detail };
  const { probability, rationale, claims } = parsed.value;
  if (arm === "no_research") return { status: "valid", probability, rationale, claims: [] };

  const decisions: ClaimDecision[] = claims.map((claim, claimIndex) => ({
    ...claim,
    claimIndex,
    verdict: verifyClaim(claim, promptEvidence, ledger, fullExcerptLength),
  }));
  const feedback: StructuralFeedback[] =
    decisions.length === 0
      ? [{ claimIndex: 0, code: "empty" }]
      : decisions.flatMap((d) => (d.verdict === "supported" ? [] : [{ claimIndex: d.claimIndex, code: d.verdict }]));
  if (feedback.length > 0) {
    return {
      status: "withheld",
      probability,
      rationale,
      claims: decisions,
      feedback,
      correctable: true,
      reason: decisions.length === 0 ? "Research output has no claims." : "At least one attached claim is not an exact supported span.",
    };
  }
  return { status: "valid", probability, rationale, claims: decisions };
}

/**
 * Post-inference outcome tripwire. Runs only after inference, on the offline audit text, and only
 * flags attempts: correction planning uses the critic-only evaluation, so hidden audit text never
 * decides whether or what correction is requested. It catches an exact resolution sentence (case
 * and whitespace normalized), not paraphrases.
 */
export function outcomeTripwire(evaluation: AttemptEvaluation, resolutionAuditText: string): boolean {
  if (evaluation.status === "failed") return false;
  const needle = normalize(resolutionAuditText);
  if (needle.length < 8) return false;
  const haystacks = [evaluation.rationale, ...evaluation.claims.map((c) => c.text)].map(normalize);
  return haystacks.some((text) => text.includes(needle));
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}
