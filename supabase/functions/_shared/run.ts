/**
 * Run freezing, recorded replay and run scoring (PLAN.md s.1 demo journey, s.3, s.4 state rules).
 *
 * A run freezes evaluation/training IDs, protocol, model profile and versions before any score is
 * visible. Replay-only mode has no provider path: a missing recording is replay_miss.
 */

import { hashCanonical } from "./canonical.ts";
import { pendingArm, planArm, type ArmResult, type AttemptRecord } from "./attempts.ts";
import { clusterBootstrap, intervalGate, type BootstrapInterval } from "./bootstrap.ts";
import { evaluateOutput, outcomeTripwire, type AttemptEvaluation } from "./critic.ts";
import { compareIds, gateEvidence, type GateResult, type QuestionFunnel } from "./evidence.ts";
import {
  BLOCKLIST_VERSION,
  CORE_VERSION,
  GATE_VERSION,
  LIMITS,
  PROMPT_VERSION,
  type DatasetVersion,
  type FrozenQuestion,
  type ModelArm,
  type RecordedAttempt,
} from "./manifest.ts";
import { buildForecastInput, buildMessages, liveEligibility, type LiveEligibility, type ModelProfile } from "./prompt.ts";
import {
  baseRateFor,
  marketAsOf,
  pairedLosses,
  summarize,
  type ArmSummary,
  type BaseRate,
  type MarketSelection,
  type PairedLoss,
  type ScoredPair,
} from "./scoring.ts";
import { parseUtc } from "./time.ts";

export type RunMode = "replay" | "live";
export type RunStatus = "created" | "processing" | "completed" | "partial" | "failed" | "cancelled";

export type RunManifest = {
  runId: string;
  createdAt: string;
  mode: RunMode;
  datasetId: string;
  datasetKind: DatasetVersion["kind"];
  datasetVersionHash: string;
  protocolHash: string;
  evaluationIds: string[];
  excluded: { questionId: string; reasons: string[] }[];
  trainingIds: string[];
  modelProfile: ModelProfile | null;
  liveEligibility: LiveEligibility | null;
  recordingsHash: string | null;
  coreVersion: string;
  promptVersion: string;
  gateVersion: string;
  blocklistVersion: string;
  manifestHash: string;
};

export type FreezeRunOptions = {
  runId: string;
  createdAt: string;
  mode: RunMode;
  profile: ModelProfile | null;
  allowlist: readonly string[];
  recordingsHash: string | null;
};

export type FreezeRunResult = { ok: true; manifest: RunManifest } | { ok: false; code: string; reasons: string[] };

export function freezeRun(version: DatasetVersion, options: FreezeRunOptions): FreezeRunResult {
  const created = parseUtc(options.createdAt);
  if (created == null) return { ok: false, code: "invalid_input", reasons: ["createdAt must be explicit UTC."] };
  const evaluation = version.questions.filter((q) => q.role === "evaluation");
  const excluded: { questionId: string; reasons: string[] }[] = [];
  const eligible: FrozenQuestion[] = [];
  for (const q of evaluation) {
    const reasons = [...q.quarantineReasons];
    const resolved = parseUtc(q.resolvedAt);
    if (resolved == null || resolved > created) reasons.push("resolved_after_run_created");
    if (reasons.length > 0) excluded.push({ questionId: q.id, reasons });
    else eligible.push(q);
  }
  let eligibility: LiveEligibility | null = null;
  if (options.mode === "live") {
    if (options.profile == null) return { ok: false, code: "configuration_required", reasons: ["No server model profile."] };
    eligibility = liveEligibility(options.profile, eligible.map((q) => q.opensAt), options.allowlist);
    if (!eligibility.eligible) return { ok: false, code: "configuration_required", reasons: eligibility.reasons };
  } else if (options.recordingsHash == null) {
    return { ok: false, code: "invalid_input", reasons: ["Replay needs a recordings hash."] };
  }
  const body = {
    runId: options.runId,
    createdAt: options.createdAt,
    mode: options.mode,
    datasetId: version.datasetId,
    datasetKind: version.kind,
    datasetVersionHash: version.versionHash,
    protocolHash: version.protocolHash,
    evaluationIds: eligible.map((q) => q.id).sort(compareIds),
    excluded: excluded.sort((a, b) => compareIds(a.questionId, b.questionId)),
    trainingIds: version.questions
      .filter((q) => q.role === "training" && q.status === "eligible")
      .map((q) => q.id)
      .sort(compareIds),
    modelProfile: options.mode === "live" ? options.profile : null,
    liveEligibility: eligibility,
    recordingsHash: options.mode === "replay" ? options.recordingsHash : null,
    coreVersion: CORE_VERSION,
    promptVersion: PROMPT_VERSION,
    gateVersion: GATE_VERSION,
    blocklistVersion: BLOCKLIST_VERSION,
  };
  return { ok: true, manifest: { ...body, manifestHash: hashCanonical(body) } };
}

export function recomputeManifestHash(manifest: RunManifest): string {
  const { manifestHash: _ignored, ...body } = manifest;
  void _ignored;
  return hashCanonical(body);
}

export function questionById(version: DatasetVersion, id: string): FrozenQuestion {
  const q = version.questions.find((item) => item.id === id);
  if (q == null) throw new Error(`Question ${id} is not in this dataset version.`);
  return q;
}

/** Gate a frozen evaluation question using only its as-of fields and evidence rows. */
export function gateForQuestion(version: DatasetVersion, question: FrozenQuestion): GateResult {
  return gateEvidence(
    { id: question.id, cutoffAt: question.cutoffAt ?? "", evidenceCutoff: question.evidenceCutoff ?? "" },
    version.evidence.filter((e) => e.questionId === question.id),
    version.protocol,
    LIMITS.excerptCodePoints,
  );
}

export function fullExcerptLengthLookup(version: DatasetVersion): (evidenceId: string) => number | null {
  const lengths = new Map(version.evidence.map((e) => [e.id, e.excerpt.length]));
  return (id) => lengths.get(id) ?? null;
}

export type QuestionExecution = {
  questionId: string;
  gate: GateResult;
  arms: Record<ModelArm, ArmResult>;
};

export type RunExecution = {
  runId: string;
  manifestHash: string;
  status: RunStatus;
  items: QuestionExecution[];
};

/**
 * Post-inference audit flags. They read the offline resolution text only after a model output
 * exists and never change the attempt's critic evaluation, so they cannot decide whether a
 * correction is requested or what it contains.
 */
export function auditFlagsFor(arm: ModelArm, evaluation: AttemptEvaluation, question: FrozenQuestion): string[] {
  if (!outcomeTripwire(evaluation, question.resolutionAuditText)) return [];
  return [arm === "research" ? "outcome_tripwire" : "outcome_sentence_in_no_research"];
}

/**
 * Applied once the arm is terminal: a selected research attempt with a tripwire hit is withheld as
 * an explicit audit failure (raw probability kept unscored). No further call follows. A
 * no-research hit stays a visible flag only.
 */
export function applyPostInferenceAudit(result: ArmResult): ArmResult {
  if (result.arm !== "research" || result.state !== "done") return result;
  const selected = result.attempts.find((a) => a.attemptId === result.selectedAttemptId);
  if (selected == null || !selected.auditFlags.includes("outcome_tripwire")) return result;
  return {
    ...result,
    state: "withheld",
    selectedAttemptId: null,
    probability: null,
    withheldProbability: result.probability,
    reasonCode: "withheld_audit",
    reason: "audit_outcome_tripwire: the selected output repeats the offline resolution sentence; kept unscored, no correction.",
  };
}

/** Replay recorded attempts through the same gate, critic, audit and attempt rules. No provider path. */
export function replayRun(version: DatasetVersion, manifest: RunManifest, recordings: readonly RecordedAttempt[]): RunExecution {
  const fullLength = fullExcerptLengthLookup(version);
  const items = manifest.evaluationIds.map((questionId) => {
    const question = questionById(version, questionId);
    const gate = gateForQuestion(version, question);
    const arms = {} as Record<ModelArm, ArmResult>;
    // No-research reaches a terminal state first; research follows regardless of its result.
    for (const arm of ["no_research", "research"] as const) {
      const attempts: AttemptRecord[] = [];
      for (;;) {
        const step = planArm(questionId, arm, gate.promptEvidence.length, attempts);
        if (step.action === "stop") {
          arms[arm] = applyPostInferenceAudit(step.result);
          break;
        }
        const input = buildForecastInput({ id: question.id, questionTextAsOf: question.questionTextAsOf, resolutionRulesAsOf: question.resolutionRulesAsOf, cutoffAt: question.cutoffAt ?? "" }, gate.promptEvidence, arm);
        const messages = buildMessages(input, step.feedback);
        const recording = recordings.find((r) => r.questionId === questionId && r.arm === arm && r.sequence === step.sequence);
        let evaluation: AttemptEvaluation;
        let flags: string[] = [];
        if (recording == null) {
          attempts.push(replayMissAttempt(manifest.runId, questionId, arm, step.sequence, step.kind, hashCanonical(messages), gate.promptEvidenceHash));
          continue;
        } else if (recording.output.kind === "failure") {
          evaluation = { status: "failed", code: recording.output.code, detail: "Recorded failure." };
        } else {
          evaluation = evaluateOutput(recording.output.text, arm, gate.promptEvidence, gate.ledger, fullLength);
          flags = auditFlagsFor(arm, evaluation, question);
        }
        attempts.push({
          attemptId: recording?.id ?? `${manifest.runId}:${questionId}:${arm}:${step.sequence}:miss`,
          questionId,
          arm,
          sequence: step.sequence,
          kind: step.kind,
          origin: recording?.origin ?? "recorded",
          requestHash: hashCanonical(messages),
          promptEvidenceHash: gate.promptEvidenceHash,
          evaluation,
          auditFlags: flags,
          model: recording?.model ?? null,
          rawText: recording?.output.kind === "text" ? recording.output.text : null,
        });
      }
    }
    return { questionId, gate, arms };
  });
  const incomplete = items.some((item) => Object.values(item.arms).some((a) => a.state === "pending" || a.reasonCode === "replay_miss"));
  return { runId: manifest.runId, manifestHash: manifest.manifestHash, status: incomplete ? "partial" : "completed", items };
}

export const REPLAY_MISS_DETAIL = "No recording for this attempt. Replay never falls back to a provider.";

/**
 * The attempt record for a replay slot with no frozen recording. The database stores no attempt row
 * for it (run_items.reason_code = replay_miss); stored-run reconstruction re-creates this record.
 */
export function replayMissAttempt(runId: string, questionId: string, arm: ModelArm, sequence: 1 | 2, kind: AttemptRecord["kind"], requestHash: string, promptEvidenceHash: string): AttemptRecord {
  return {
    attemptId: `${runId}:${questionId}:${arm}:${sequence}:miss`,
    questionId,
    arm,
    sequence,
    kind,
    origin: "recorded",
    requestHash,
    promptEvidenceHash,
    evaluation: { status: "failed", code: "replay_miss", detail: REPLAY_MISS_DETAIL },
    auditFlags: [],
    model: null,
    rawText: null,
  };
}

/** Rebuild arm results from stored attempts (used by Verify bundle and by paused live runs). */
export function rederiveArm(questionId: string, arm: ModelArm, evidenceCount: number, attempts: readonly AttemptRecord[]): ArmResult {
  const step = planArm(questionId, arm, evidenceCount, attempts);
  return step.action === "stop" ? applyPostInferenceAudit(step.result) : pendingArm(questionId, arm, attempts);
}

// ---------------------------------------------------------------------------------------------
// Scoring a run.

export type PolicyTier = "research" | "no_research" | "half";

export type ItemScore = {
  questionId: string;
  clusterId: string;
  category: string;
  outcome: 0 | 1;
  market: MarketSelection;
  baseRate: BaseRate;
  noResearch: { state: ArmResult["state"]; probability: number | null; reasonCode: string };
  research: { state: ArmResult["state"]; probability: number | null; withheldProbability: number | null; reasonCode: string };
  policy: { probability: number; tier: PolicyTier };
  funnel: QuestionFunnel;
};

export type PairedComparison = {
  label: string;
  n: number;
  ids: string[];
  clusterCount: number;
  meanDifference: number | null;
  rows: PairedLoss[];
  interval: BootstrapInterval | null;
  intervalNote: string;
};

export type RunReport = {
  runId: string;
  datasetVersionHash: string;
  manifestHash: string;
  datasetKind: DatasetVersion["kind"];
  calibrationBins: number;
  eligibleN: number;
  marketMissingN: number;
  cohorts: { all: string[]; marketPaired: string[]; strictResearch: string[]; completeCase: string[] };
  policy: { all: ArmSummary; marketPaired: ArmSummary; tierCounts: Record<PolicyTier, number>; tierCountsMarketPaired: Record<PolicyTier, number> };
  arms: { market: ArmSummary; baseRate: ArmSummary; half: ArmSummary; noResearch: ArmSummary; research: ArmSummary };
  completeCase: { market: ArmSummary; baseRate: ArmSummary; half: ArmSummary; noResearch: ArmSummary; research: ArmSummary };
  primary: PairedComparison;
  secondary: PairedComparison;
  reasonCounts: { research: Record<string, number>; noResearch: Record<string, number>; market: Record<string, number>; baseRate: Record<string, number> };
  items: ItemScore[];
  caution: string;
  metricsHash: string;
};

function countBy<T>(rows: readonly T[], key: (row: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows) out[key(row)] = (out[key(row)] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => compareIds(a, b)));
}

function compare(label: string, a: ScoredPair[], b: ScoredPair[], kind: DatasetVersion["kind"], seed: number, replicates: number): PairedComparison {
  const rows = pairedLosses(a, b);
  const items = rows.map((r) => ({ questionId: r.questionId, clusterId: r.clusterId, difference: r.difference }));
  const gate = rows.length === 0 ? { available: false as const, reason: "No paired items." } : intervalGate(kind, items);
  return {
    label,
    n: rows.length,
    ids: rows.map((r) => r.questionId),
    clusterCount: new Set(rows.map((r) => r.clusterId)).size,
    meanDifference: rows.length === 0 ? null : rows.reduce((sum, r) => sum + r.difference, 0) / rows.length,
    rows,
    interval: gate.available ? clusterBootstrap(items, seed, replicates) : null,
    intervalNote: gate.available ? "Seeded paired cluster-percentile 95% interval; exchangeability and representative selection remain assumptions." : gate.reason,
  };
}

export function scoreRun(version: DatasetVersion, manifest: RunManifest, execution: RunExecution): RunReport {
  const protocol = version.protocol;
  const bins = protocol.calibrationBins;
  const training = version.questions.filter((q) => manifest.trainingIds.includes(q.id));
  const byQuestion = new Map(execution.items.map((item) => [item.questionId, item]));

  const items: ItemScore[] = manifest.evaluationIds.map((questionId) => {
    const q = questionById(version, questionId);
    const exec = byQuestion.get(questionId);
    if (exec == null) throw new Error(`Execution is missing question ${questionId}.`);
    const nr = exec.arms.no_research;
    const rs = exec.arms.research;
    const nrP = nr.state === "done" ? nr.probability : null;
    const rsP = rs.state === "done" ? rs.probability : null;
    const tier: PolicyTier = rsP != null ? "research" : nrP != null ? "no_research" : "half";
    return {
      questionId,
      clusterId: q.eventClusterId,
      category: q.category,
      outcome: q.outcome as 0 | 1,
      market: marketAsOf(version.marketObservations.filter((o) => o.questionId === questionId), q.cutoffAt ?? "", protocol.maxPriceAgeHours),
      baseRate: baseRateFor(q, training, protocol.trainMinimum),
      noResearch: { state: nr.state, probability: nrP, reasonCode: nr.reasonCode },
      research: { state: rs.state, probability: rsP, withheldProbability: rs.withheldProbability, reasonCode: rs.reasonCode },
      policy: { probability: rsP ?? nrP ?? 0.5, tier },
      funnel: exec.gate.funnel,
    };
  });

  const pair = (item: ItemScore, probability: number): ScoredPair => ({ questionId: item.questionId, clusterId: item.clusterId, probability, outcome: item.outcome });
  const marketPairs = items.flatMap((i) => (i.market.probability != null ? [pair(i, i.market.probability)] : []));
  const basePairs = items.flatMap((i) => (i.baseRate.probability != null ? [pair(i, i.baseRate.probability)] : []));
  const halfPairs = items.map((i) => pair(i, 0.5));
  const nrPairs = items.flatMap((i) => (i.noResearch.probability != null ? [pair(i, i.noResearch.probability)] : []));
  const rsPairs = items.flatMap((i) => (i.research.probability != null ? [pair(i, i.research.probability)] : []));
  const policyPairs = items.map((i) => pair(i, i.policy.probability));

  const marketIds = new Set(marketPairs.map((p) => p.questionId));
  const complete = items
    .filter((i) => i.market.probability != null && i.baseRate.probability != null && i.noResearch.probability != null && i.research.probability != null)
    .map((i) => i.questionId);
  const completeSet = new Set(complete);
  const only = (pairs: ScoredPair[], ids: Set<string>) => pairs.filter((p) => ids.has(p.questionId));

  const tierCounts: Record<PolicyTier, number> = { research: 0, no_research: 0, half: 0 };
  const tierCountsMarketPaired: Record<PolicyTier, number> = { research: 0, no_research: 0, half: 0 };
  for (const item of items) {
    tierCounts[item.policy.tier] += 1;
    if (item.market.probability != null) tierCountsMarketPaired[item.policy.tier] += 1;
  }

  const seed = protocol.bootstrapSeed;
  const replicates = protocol.bootstrapReplicates;
  const report = {
    runId: manifest.runId,
    datasetVersionHash: manifest.datasetVersionHash,
    manifestHash: manifest.manifestHash,
    datasetKind: version.kind,
    calibrationBins: bins,
    eligibleN: items.length,
    marketMissingN: items.length - marketPairs.length,
    cohorts: {
      all: items.map((i) => i.questionId),
      marketPaired: [...marketIds].sort(compareIds),
      strictResearch: rsPairs.map((p) => p.questionId).sort(compareIds),
      completeCase: complete.sort(compareIds),
    },
    policy: {
      all: summarize("Policy (all eligible)", policyPairs, bins),
      marketPaired: summarize("Policy (market-paired)", only(policyPairs, marketIds), bins),
      tierCounts,
      tierCountsMarketPaired,
    },
    arms: {
      market: summarize("Market as-of", marketPairs, bins),
      baseRate: summarize("Training base rate", basePairs, bins),
      half: summarize("Always 0.5", halfPairs, bins),
      noResearch: summarize("No research", nrPairs, bins),
      research: summarize("Strict research (conditional)", rsPairs, bins),
    },
    completeCase: {
      market: summarize("Market (complete case)", only(marketPairs, completeSet), bins),
      baseRate: summarize("Base rate (complete case)", only(basePairs, completeSet), bins),
      half: summarize("Always 0.5 (complete case)", only(halfPairs, completeSet), bins),
      noResearch: summarize("No research (complete case)", only(nrPairs, completeSet), bins),
      research: summarize("Research (complete case)", only(rsPairs, completeSet), bins),
    },
    primary: compare("Policy minus market (mean Brier loss)", policyPairs, marketPairs, version.kind, seed, replicates),
    secondary: compare("Strict research minus market (exploratory, conditional cohort)", rsPairs, marketPairs, version.kind, seed, replicates),
    reasonCounts: {
      research: countBy(items, (i) => i.research.reasonCode),
      noResearch: countBy(items, (i) => i.noResearch.reasonCode),
      market: countBy(items, (i) => i.market.status),
      baseRate: countBy(items, (i) => i.baseRate.status),
    },
    items,
    caution:
      version.kind === "synthetic"
        ? "Synthetic data: these numbers demonstrate arithmetic and control flow only, never real model performance."
        : items.length < 30
          ? `Real data with n=${items.length} < 30: descriptive arithmetic only, no model ranking.`
          : "Real data: thresholds are display cautions, not statistical guarantees. No p-values or superiority claims.",
  };
  return { ...report, metricsHash: hashCanonical(report) };
}

export function recomputeMetricsHash(report: RunReport): string {
  const { metricsHash: _ignored, ...body } = report;
  void _ignored;
  return hashCanonical(body);
}
