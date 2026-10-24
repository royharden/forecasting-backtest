/**
 * Per-arm attempt planning and selection (PLAN.md s.4 "Exact workflow").
 *
 * Two total charged calls per arm cover transient retries and any structural correction together.
 * The first valid attempt in execution order is selected before any loss is looked at.
 * No-research reaches a terminal state before research starts; its failure does not block research.
 */

import type { AttemptEvaluation } from "./critic.ts";
import { LIMITS, type ModelArm, type ModelMeta } from "./manifest.ts";
import type { StructuralFeedback } from "./prompt.ts";

export type AttemptOrigin = "demo" | "recorded" | "manual" | "live" | "cache_hit";
export type AttemptKind = "first" | "correction" | "retry";

/** Failure codes that permit the remaining attempt (after a persisted retry_not_before). */
export const TRANSIENT_FAILURES = new Set(["provider_transient"]);

export type AttemptRecord = {
  attemptId: string;
  questionId: string;
  arm: ModelArm;
  sequence: 1 | 2;
  kind: AttemptKind;
  origin: AttemptOrigin;
  /** SHA-256 of the exact canonical model messages sent (or replayed) for this attempt. */
  requestHash: string;
  promptEvidenceHash: string;
  evaluation: AttemptEvaluation;
  auditFlags: string[];
  model: ModelMeta | null;
  rawText: string | null;
};

export type ArmState = "done" | "withheld" | "failed" | "skipped" | "pending";

export type ArmResult = {
  questionId: string;
  arm: ModelArm;
  state: ArmState;
  selectedAttemptId: string | null;
  /** Scorable probability: only from the selected valid attempt. */
  probability: number | null;
  /** Unscored probability kept for audit when the arm ended withheld. */
  withheldProbability: number | null;
  reason: string;
  reasonCode: string;
  chargedCalls: number;
  attempts: AttemptRecord[];
};

export type NextStep =
  | { action: "call"; kind: AttemptKind; sequence: 1 | 2; feedback: StructuralFeedback[] | null }
  | { action: "stop"; result: ArmResult };

function charged(attempts: readonly AttemptRecord[]): number {
  return attempts.filter((a) => a.origin !== "cache_hit").length;
}

export function sortAttempts(attempts: readonly AttemptRecord[]): AttemptRecord[] {
  return [...attempts].sort((a, b) => a.sequence - b.sequence);
}

/** Decide the next call for one arm, or its terminal result. */
export function planArm(questionId: string, arm: ModelArm, promptEvidenceCount: number, attempts: readonly AttemptRecord[]): NextStep {
  const ordered = sortAttempts(attempts);
  if (arm === "research" && promptEvidenceCount === 0 && ordered.length === 0) {
    return {
      action: "stop",
      result: terminal(questionId, arm, ordered, "skipped", "insufficient_evidence", "The strict evidence pack is empty, so the research call was skipped."),
    };
  }
  const valid = ordered.find((a) => a.evaluation.status === "valid");
  if (valid != null) return { action: "stop", result: selected(questionId, arm, ordered, valid) };
  if (ordered.length === 0) return { action: "call", kind: "first", sequence: 1, feedback: null };
  if (ordered.length >= LIMITS.attemptsPerArm) return { action: "stop", result: exhausted(questionId, arm, ordered) };

  const last = ordered[ordered.length - 1];
  const evaluation = last.evaluation;
  if (evaluation.status === "withheld" && evaluation.correctable) {
    return { action: "call", kind: "correction", sequence: 2, feedback: evaluation.feedback };
  }
  if (evaluation.status === "failed" && TRANSIENT_FAILURES.has(evaluation.code)) {
    return { action: "call", kind: "retry", sequence: 2, feedback: null };
  }
  return { action: "stop", result: exhausted(questionId, arm, ordered) };
}

function selected(questionId: string, arm: ModelArm, attempts: AttemptRecord[], attempt: AttemptRecord): ArmResult {
  const evaluation = attempt.evaluation;
  return {
    questionId,
    arm,
    state: "done",
    selectedAttemptId: attempt.attemptId,
    probability: evaluation.status === "valid" ? evaluation.probability : null,
    withheldProbability: null,
    reason: attempt.kind === "first" ? "First attempt valid." : `Attempt ${attempt.sequence} (${attempt.kind}) valid.`,
    reasonCode: "valid",
    chargedCalls: charged(attempts),
    attempts,
  };
}

function exhausted(questionId: string, arm: ModelArm, attempts: AttemptRecord[]): ArmResult {
  const withheld = [...attempts].reverse().find((a) => a.evaluation.status === "withheld");
  if (withheld != null && withheld.evaluation.status === "withheld") {
    const code = withheld.evaluation.correctable ? "withheld_unsupported_claims" : "withheld_audit";
    return {
      ...terminal(questionId, arm, attempts, "withheld", code, withheld.evaluation.reason),
      withheldProbability: withheld.evaluation.probability,
    };
  }
  const last = attempts[attempts.length - 1];
  const code = last.evaluation.status === "failed" ? last.evaluation.code : "failed";
  const detail = last.evaluation.status === "failed" ? last.evaluation.detail : "No valid attempt.";
  return terminal(questionId, arm, attempts, "failed", code, detail);
}

function terminal(questionId: string, arm: ModelArm, attempts: AttemptRecord[], state: ArmState, reasonCode: string, reason: string): ArmResult {
  return {
    questionId,
    arm,
    state,
    selectedAttemptId: null,
    probability: null,
    withheldProbability: null,
    reason,
    reasonCode,
    chargedCalls: charged(attempts),
    attempts,
  };
}

/** Result of an arm whose work has not finished (e.g. a paused processing run). */
export function pendingArm(questionId: string, arm: ModelArm, attempts: readonly AttemptRecord[]): ArmResult {
  return terminal(questionId, arm, sortAttempts(attempts), "pending", "pending", "Not finished; a paused run records this as missing.");
}
