/**
 * Baselines, metrics and cohorts (PLAN.md s.3).
 *
 * Primary comparison: policy-minus-market mean Brier loss on the market-paired cohort (negative
 * favors the policy). Strict research is reported conditionally on valid supported outputs with
 * its abstention/failure reasons. Pairwise deltas only ever use identical question IDs.
 */

import { compareIds } from "./evidence.ts";
import type { FrozenQuestion, MarketObservation } from "./manifest.ts";
import { HOUR_MS, isoUtc, parseUtc } from "./time.ts";

export const LOG_EPSILON = 1e-6;

export type ScoredPair = { questionId: string; clusterId: string; probability: number; outcome: 0 | 1 };

export class ScoreInputError extends Error {}

function checkPair(pair: ScoredPair): void {
  if (!Number.isFinite(pair.probability) || pair.probability < 0 || pair.probability > 1) {
    throw new ScoreInputError(`Probability for ${pair.questionId} must be finite and in [0, 1].`);
  }
  if (pair.outcome !== 0 && pair.outcome !== 1) throw new ScoreInputError(`Outcome for ${pair.questionId} must be 0 or 1.`);
}

/** Brier mean((p - y)^2). No rounding before calculation. */
export function brier(pairs: readonly ScoredPair[]): number | null {
  if (pairs.length === 0) return null;
  let total = 0;
  for (const pair of pairs) {
    checkPair(pair);
    total += (pair.probability - pair.outcome) ** 2;
  }
  return total / pairs.length;
}

/** Brier skill against always-0.5 on the identical IDs: 1 - Brier / 0.25. */
export function brierSkillVsHalf(pairs: readonly ScoredPair[]): number | null {
  const score = brier(pairs);
  return score == null ? null : 1 - score / 0.25;
}

/** Secondary: log loss. Only this calculation clips probabilities, with epsilon 1e-6. */
export function logLoss(pairs: readonly ScoredPair[]): number | null {
  if (pairs.length === 0) return null;
  let total = 0;
  for (const pair of pairs) {
    checkPair(pair);
    const p = Math.min(1 - LOG_EPSILON, Math.max(LOG_EPSILON, pair.probability));
    total += -(pair.outcome * Math.log(p) + (1 - pair.outcome) * Math.log(1 - p));
  }
  return total / pairs.length;
}

export type CalibrationBin = {
  index: number;
  lower: number;
  upper: number;
  count: number;
  meanProbability: number | null;
  yesFraction: number | null;
};

/** Bins are left-closed/right-open; the final bin's right edge includes 1. */
export function binIndex(probability: number, binCount: number): number {
  return Math.min(binCount - 1, Math.floor(probability * binCount));
}

export function calibrationBins(pairs: readonly ScoredPair[], binCount: number): CalibrationBin[] {
  const bins: CalibrationBin[] = Array.from({ length: binCount }, (_, index) => ({
    index,
    lower: index / binCount,
    upper: (index + 1) / binCount,
    count: 0,
    meanProbability: null,
    yesFraction: null,
  }));
  const sums = bins.map(() => ({ p: 0, y: 0 }));
  for (const pair of pairs) {
    checkPair(pair);
    const index = binIndex(pair.probability, binCount);
    bins[index].count += 1;
    sums[index].p += pair.probability;
    sums[index].y += pair.outcome;
  }
  return bins.map((bin, index) =>
    bin.count === 0 ? bin : { ...bin, meanProbability: sums[index].p / bin.count, yesFraction: sums[index].y / bin.count },
  );
}

/** Secondary: expected calibration error on the frozen bins. */
export function expectedCalibrationError(pairs: readonly ScoredPair[], binCount: number): number | null {
  if (pairs.length === 0) return null;
  return calibrationBins(pairs, binCount).reduce(
    (sum, bin) => (bin.count === 0 ? sum : sum + (bin.count / pairs.length) * Math.abs((bin.yesFraction as number) - (bin.meanProbability as number))),
    0,
  );
}

export type MurphySplit = { reliability: number; resolution: number; uncertainty: number; binnedBrier: number };

/**
 * Secondary: binned Murphy decomposition. It equals the binned Brier (each forecast replaced by its
 * bin mean), not the raw Brier when probabilities vary inside a bin.
 */
export function murphySplit(pairs: readonly ScoredPair[], binCount: number): MurphySplit | null {
  if (pairs.length === 0) return null;
  const n = pairs.length;
  const base = pairs.reduce((sum, pair) => sum + pair.outcome, 0) / n;
  let reliability = 0;
  let resolution = 0;
  for (const bin of calibrationBins(pairs, binCount)) {
    if (bin.count === 0) continue;
    reliability += (bin.count / n) * ((bin.meanProbability as number) - (bin.yesFraction as number)) ** 2;
    resolution += (bin.count / n) * ((bin.yesFraction as number) - base) ** 2;
  }
  const uncertainty = base * (1 - base);
  return { reliability, resolution, uncertainty, binnedBrier: reliability - resolution + uncertainty };
}

// ---------------------------------------------------------------------------------------------
// Baselines.

export type MarketSelection = {
  status: "ok" | "missing" | "stale" | "ambiguous";
  probability: number | null;
  observationId: string | null;
  observedAt: string | null;
  venue: string | null;
  provenance: string | null;
  detail: string;
};

/**
 * Last valid YES observation at or before cutoff, at most maxAgeHours old. No interpolation, no
 * final price and no 0.5 substitute. Conflicting prices at the latest timestamp make it ambiguous.
 */
export function marketAsOf(observations: readonly MarketObservation[], cutoffAt: string, maxAgeHours: number): MarketSelection {
  const cutoff = parseUtc(cutoffAt);
  const none = { probability: null, observationId: null, observedAt: null, venue: null, provenance: null };
  if (cutoff == null) return { status: "missing", ...none, detail: "No valid cutoff." };
  const prior = observations
    .map((o) => ({ o, at: parseUtc(o.observedAt) }))
    .filter((x): x is { o: MarketObservation; at: number } => x.at != null && x.at <= cutoff);
  if (prior.length === 0) return { status: "missing", ...none, detail: "No price observed at or before the cutoff." };
  const latest = Math.max(...prior.map((x) => x.at));
  const atLatest = prior.filter((x) => x.at === latest);
  const values = new Set(atLatest.map((x) => x.o.yesProbability));
  if (values.size > 1) {
    return { status: "ambiguous", ...none, observedAt: isoUtc(latest), detail: "Conflicting prices at the same latest timestamp; none is selected." };
  }
  const chosen = [...atLatest].sort((a, b) => compareIds(a.o.id, b.o.id))[0].o;
  if (cutoff - latest > maxAgeHours * HOUR_MS) {
    return { status: "stale", ...none, observedAt: chosen.observedAt, detail: `Latest price is older than ${maxAgeHours}h at the cutoff.` };
  }
  return {
    status: "ok",
    probability: chosen.yesProbability,
    observationId: chosen.id,
    observedAt: chosen.observedAt,
    venue: chosen.venue,
    provenance: chosen.provenance,
    detail: "Last valid observation at or before the cutoff.",
  };
}

export type BaseRate = {
  status: "category" | "global" | "unavailable";
  probability: number | null;
  n: number;
  trainingIds: string[];
  resolvedFrom: string | null;
  resolvedTo: string | null;
  detail: string;
};

/**
 * Category YES proportion of the separate frozen training cohort resolved strictly before the
 * evaluation cutoff, excluding the same question and event cluster. Requires n >= minimum, else a
 * global training cohort with n >= minimum, else unavailable. Evaluation outcomes are never used.
 */
export function baseRateFor(question: FrozenQuestion, training: readonly FrozenQuestion[], minimum: number): BaseRate {
  const cutoff = parseUtc(question.cutoffAt);
  const empty = { probability: null, n: 0, trainingIds: [], resolvedFrom: null, resolvedTo: null };
  if (cutoff == null) return { status: "unavailable", ...empty, detail: "No valid cutoff." };
  const pool = training.filter((t) => {
    const resolved = parseUtc(t.resolvedAt);
    return (
      t.role === "training" &&
      t.status === "eligible" &&
      t.id !== question.id &&
      t.eventClusterId !== question.eventClusterId &&
      resolved != null &&
      resolved < cutoff &&
      (t.outcome === 0 || t.outcome === 1)
    );
  });
  const describe = (rows: FrozenQuestion[], status: "category" | "global", label: string): BaseRate => {
    const times = rows.map((t) => parseUtc(t.resolvedAt) as number);
    return {
      status,
      probability: rows.reduce((sum, t) => sum + (t.outcome as number), 0) / rows.length,
      n: rows.length,
      trainingIds: rows.map((t) => t.id).sort(compareIds),
      resolvedFrom: isoUtc(Math.min(...times)),
      resolvedTo: isoUtc(Math.max(...times)),
      detail: label,
    };
  };
  const category = pool.filter((t) => t.category === question.category);
  if (category.length >= minimum) return describe(category, "category", `Category "${question.category}" training cohort, n=${category.length}.`);
  if (pool.length >= minimum) return describe(pool, "global", `Category n=${category.length} < ${minimum}; global training cohort n=${pool.length}.`);
  return {
    status: "unavailable",
    ...empty,
    n: pool.length,
    detail: `Training cohort before this cutoff has category n=${category.length} and global n=${pool.length}; both < ${minimum}. Not lowered.`,
  };
}

// ---------------------------------------------------------------------------------------------
// Summaries and paired deltas.

export type ArmSummary = {
  label: string;
  n: number;
  ids: string[];
  brier: number | null;
  skillVsHalf: number | null;
  logLoss: number | null;
  ece: number | null;
  murphy: MurphySplit | null;
  bins: CalibrationBin[];
};

export function summarize(label: string, pairs: readonly ScoredPair[], binCount: number): ArmSummary {
  return {
    label,
    n: pairs.length,
    ids: pairs.map((p) => p.questionId).sort(compareIds),
    brier: brier(pairs),
    skillVsHalf: brierSkillVsHalf(pairs),
    logLoss: logLoss(pairs),
    ece: expectedCalibrationError(pairs, binCount),
    murphy: murphySplit(pairs, binCount),
    bins: calibrationBins(pairs, binCount),
  };
}

export type PairedLoss = { questionId: string; clusterId: string; lossA: number; lossB: number; difference: number };

/** Per-item Brier loss differences A - B on the intersection of identical question IDs only. */
export function pairedLosses(a: readonly ScoredPair[], b: readonly ScoredPair[]): PairedLoss[] {
  const byId = new Map(b.map((pair) => [pair.questionId, pair]));
  const rows: PairedLoss[] = [];
  for (const pairA of a) {
    const pairB = byId.get(pairA.questionId);
    if (pairB == null) continue;
    checkPair(pairA);
    checkPair(pairB);
    const lossA = (pairA.probability - pairA.outcome) ** 2;
    const lossB = (pairB.probability - pairB.outcome) ** 2;
    rows.push({ questionId: pairA.questionId, clusterId: pairA.clusterId, lossA, lossB, difference: lossA - lossB });
  }
  return rows.sort((x, y) => compareIds(x.questionId, y.questionId));
}
