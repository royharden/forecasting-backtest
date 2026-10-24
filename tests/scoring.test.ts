// Authored under Dirty Mode; not executed yet. Vectors are hand-derived.
import { describe, expect, it } from "vitest";
import {
  appendVerdict,
  auditRates,
  baseRateFor,
  binIndex,
  brier,
  brierSkillVsHalf,
  calibrationBins,
  clusterBootstrap,
  createAuditSample,
  intervalGate,
  logLoss,
  marketAsOf,
  murphySplit,
  pairedLosses,
  percentile,
  xorshift32,
  type FrozenQuestion,
  type MarketObservation,
  type ScoredPair,
} from "../supabase/functions/_shared/engine.ts";

const pair = (questionId: string, probability: number, outcome: 0 | 1, clusterId = questionId): ScoredPair => ({ questionId, clusterId, probability, outcome });

describe("Brier and secondary metrics", () => {
  it("y=[1,0], p=[.8,.3] gives Brier .065 and skill .74 against 0.5", () => {
    const pairs = [pair("a", 0.8, 1), pair("b", 0.3, 0)];
    expect(brier(pairs)).toBeCloseTo(0.065, 12);
    expect(brierSkillVsHalf(pairs)).toBeCloseTo(0.74, 12);
  });

  it("accepts p=0 and p=1 and rejects nonfinite or out-of-range p", () => {
    expect(brier([pair("a", 0, 0), pair("b", 1, 1)])).toBe(0);
    expect(() => brier([pair("a", Number.NaN, 0)])).toThrow();
    expect(() => brier([pair("a", 1.0000001, 1)])).toThrow();
    expect(() => brier([pair("a", -0.1, 0)])).toThrow();
  });

  it("clips only in log loss, at 1e-6", () => {
    // -ln(1e-6) = 13.815510557964274
    expect(logLoss([pair("a", 0, 1)])).toBeCloseTo(13.815510557964274, 9);
    expect(brier([pair("a", 0, 1)])).toBe(1);
  });

  it("returns null on empty input, never a fabricated 0", () => {
    expect(brier([])).toBeNull();
    expect(logLoss([])).toBeNull();
    expect(murphySplit([], 5)).toBeNull();
  });
});

describe("calibration bins", () => {
  it("is left-closed/right-open with 1 in the last bin (5 bins)", () => {
    expect(binIndex(0, 5)).toBe(0);
    expect(binIndex(0.19999, 5)).toBe(0);
    expect(binIndex(0.2, 5)).toBe(1);
    expect(binIndex(0.6, 5)).toBe(3);
    expect(binIndex(0.8, 5)).toBe(4);
    expect(binIndex(1, 5)).toBe(4);
  });

  it("handles ten-bin edges", () => {
    expect(binIndex(0.3, 10)).toBe(3);
    expect(binIndex(0.7, 10)).toBe(7);
    expect(binIndex(0.0999, 10)).toBe(0);
    expect(binIndex(1, 10)).toBe(9);
  });

  it("reports mean p, YES fraction and n, with empty bins left null", () => {
    const bins = calibrationBins([pair("a", 0.1, 0), pair("b", 0.15, 1), pair("c", 0.9, 1)], 5);
    expect(bins[0]).toMatchObject({ count: 2, yesFraction: 0.5 });
    expect(bins[0].meanProbability).toBeCloseTo(0.125, 12);
    expect(bins[2]).toMatchObject({ count: 0, meanProbability: null, yesFraction: null });
    expect(bins[4]).toMatchObject({ count: 1, meanProbability: 0.9, yesFraction: 1 });
  });

  it("binned Murphy equals the binned Brier, which can differ from the raw Brier", () => {
    // Bin 0 holds p=.0 (y=0) and p=.18 (y=1). Bin mean .09, yes fraction .5.
    const pairs = [pair("a", 0, 0), pair("b", 0.18, 1)];
    const m = murphySplit(pairs, 5);
    // Binned Brier = ((.09-0)^2 + (.09-1)^2)/2 = (.0081 + .8281)/2 = .4181
    expect(m?.binnedBrier).toBeCloseTo(0.4181, 12);
    // Raw Brier = (0 + .82^2)/2 = .3362
    expect(brier(pairs)).toBeCloseTo(0.3362, 12);
  });
});

describe("market as-of", () => {
  const obs = (id: string, p: number, at: string): MarketObservation => ({ id, questionId: "q", yesProbability: p, observedAt: at, venue: "v", provenance: "p" });
  const cutoff = "2024-06-01T00:00:00.000Z";

  it("takes the last observation at or before cutoff and ignores later prices", () => {
    const r = marketAsOf([obs("a", 0.6, "2024-05-31T10:00:00Z"), obs("b", 0.7, "2024-06-01T00:00:00Z"), obs("c", 0.99, "2024-06-01T00:00:01Z")], cutoff, 24);
    expect(r).toMatchObject({ status: "ok", probability: 0.7, observationId: "b" });
  });

  it("treats exactly 24h as fresh and older as stale; never substitutes 0.5", () => {
    expect(marketAsOf([obs("a", 0.6, "2024-05-31T00:00:00Z")], cutoff, 24)).toMatchObject({ status: "ok", probability: 0.6 });
    expect(marketAsOf([obs("a", 0.6, "2024-05-30T23:59:59Z")], cutoff, 24)).toMatchObject({ status: "stale", probability: null });
    expect(marketAsOf([], cutoff, 24)).toMatchObject({ status: "missing", probability: null });
  });

  it("makes conflicting same-time prices ambiguous but accepts identical duplicates", () => {
    expect(marketAsOf([obs("a", 0.3, "2024-05-31T22:00:00Z"), obs("b", 0.34, "2024-05-31T22:00:00Z")], cutoff, 24)).toMatchObject({ status: "ambiguous", probability: null });
    expect(marketAsOf([obs("a", 0.3, "2024-05-31T22:00:00Z"), obs("b", 0.3, "2024-05-31T22:00:00Z")], cutoff, 24)).toMatchObject({ status: "ok", probability: 0.3 });
  });
});

describe("training-cohort base rate", () => {
  const q = (id: string, partial: Partial<FrozenQuestion>): FrozenQuestion => ({
    id,
    role: "training",
    category: "a",
    eventClusterId: id,
    questionTextAsOf: "",
    resolutionRulesAsOf: "",
    opensAt: "2020-01-01T00:00:00Z",
    wordingAvailableAt: "2020-01-01T00:00:00Z",
    wordingVersionProof: "",
    suppliedCutoffAt: null,
    scheduledCloseAt: null,
    scheduledCloseProvenance: null,
    actualCloseAt: null,
    resolvedAt: "2023-01-01T00:00:00Z",
    outcome: 1,
    resolutionAuditText: "",
    cutoffAt: null,
    evidenceCutoff: null,
    cutoffProvenance: "",
    status: "eligible",
    quarantineReasons: [],
    ...partial,
  });
  const evalQ = q("e", { role: "evaluation", cutoffAt: "2024-01-01T00:00:00.000Z", eventClusterId: "E", outcome: 0 });

  it("uses category n >= 10, resolved strictly before the cutoff, excluding the same cluster", () => {
    const train = [
      ...Array.from({ length: 7 }, (_, i) => q(`y${i}`, { outcome: 1 })),
      ...Array.from({ length: 3 }, (_, i) => q(`n${i}`, { outcome: 0 })),
      q("same-cluster", { eventClusterId: "E", outcome: 0 }),
      q("at-cutoff", { resolvedAt: "2024-01-01T00:00:00.000Z", outcome: 0 }),
    ];
    const r = baseRateFor(evalQ, train, 10);
    expect(r).toMatchObject({ status: "category", n: 10, probability: 0.7 });
    expect(r.trainingIds).not.toContain("same-cluster");
    expect(r.trainingIds).not.toContain("at-cutoff");
  });

  it("falls back to global n >= 10, else unavailable without lowering the floor", () => {
    const mixed = [...Array.from({ length: 4 }, (_, i) => q(`a${i}`, {})), ...Array.from({ length: 6 }, (_, i) => q(`b${i}`, { category: "b", outcome: 0 }))];
    expect(baseRateFor(evalQ, mixed, 10)).toMatchObject({ status: "global", n: 10, probability: 0.4 });
    expect(baseRateFor(evalQ, mixed.slice(0, 9), 10)).toMatchObject({ status: "unavailable", probability: null });
  });

  it("ignores the evaluation question's own outcome", () => {
    const train = Array.from({ length: 10 }, (_, i) => q(`y${i}`, { outcome: i < 5 ? 1 : 0 }));
    expect(baseRateFor(evalQ, train, 10).probability).toBe(baseRateFor({ ...evalQ, outcome: 1 }, train, 10).probability);
  });
});

describe("paired comparisons use identical IDs only", () => {
  it("subtracts losses only on the intersection", () => {
    const rows = pairedLosses([pair("a", 0.7, 1), pair("b", 0.5, 0)], [pair("a", 0.72, 1), pair("c", 0.1, 0)]);
    expect(rows.map((r) => r.questionId)).toEqual(["a"]);
    expect(rows[0].difference).toBeCloseTo(0.09 - 0.0784, 12);
  });
});

describe("bootstrap", () => {
  it("xorshift32(13,17,5) from seed 1 yields 270369 then 67634689", () => {
    const next = xorshift32(1);
    expect(next()).toBe(270369);
    expect(next()).toBe(67634689);
  });

  it("rejects seed 0", () => {
    expect(() => xorshift32(0)).toThrow();
  });

  it("interpolates percentiles at (B-1)p", () => {
    expect(percentile([10, 20, 30, 40, 50], 0.025)).toBeCloseTo(11, 12);
    expect(percentile([10, 20, 30, 40, 50], 0.975)).toBeCloseTo(49, 12);
    expect(percentile([0, 1, 2, 3], 0.5)).toBe(1.5);
  });

  it("weights unequal clusters by items (pooled), not by cluster means", () => {
    // Cluster A: 3 items with difference 1. Cluster B: 1 item with difference 0.
    // Replicates can only be AA=1, AB or BA=3/4, BB=0; estimate is 3/4, not 1/2.
    const items = [
      { questionId: "a1", clusterId: "A", difference: 1 },
      { questionId: "a2", clusterId: "A", difference: 1 },
      { questionId: "a3", clusterId: "A", difference: 1 },
      { questionId: "b1", clusterId: "B", difference: 0 },
    ];
    const r = clusterBootstrap(items, 14, 2000);
    expect(r.estimate).toBe(0.75);
    expect(r.lower).toBe(0);
    expect(r.upper).toBe(1);
    expect(r.clusterCount).toBe(2);
  });

  it("collapses on zero differences and repeats exactly for the same seed", () => {
    const zero = Array.from({ length: 4 }, (_, i) => ({ questionId: `q${i}`, clusterId: `c${i % 2}`, difference: 0 }));
    expect(clusterBootstrap(zero)).toMatchObject({ lower: 0, upper: 0 });
    const items = Array.from({ length: 12 }, (_, i) => ({ questionId: `q${i}`, clusterId: `c${i % 5}`, difference: (i % 3) - 1 }));
    expect(clusterBootstrap(items, 99)).toEqual(clusterBootstrap(items, 99));
  });

  it("suppresses intervals for synthetic, small, few-cluster and zero-variance cohorts", () => {
    const items = (n: number, clusters: number, diff = (i: number) => i % 2) =>
      Array.from({ length: n }, (_, i) => ({ questionId: `q${i}`, clusterId: `c${i % clusters}`, difference: diff(i) }));
    expect(intervalGate("synthetic", items(40, 12)).available).toBe(false);
    expect(intervalGate("real", items(29, 12)).available).toBe(false);
    expect(intervalGate("real", items(40, 9)).available).toBe(false);
    expect(intervalGate("real", items(40, 12, () => 0.1)).available).toBe(false);
    expect(intervalGate("real", items(40, 12)).available).toBe(true);
  });
});

describe("audit sampling and append-only verdicts", () => {
  const population = [
    { questionId: "q2", evidenceId: "e9" },
    { questionId: "q1", evidenceId: "e2" },
    { questionId: "q1", evidenceId: "e1" },
  ];

  it("samples min(requestedN, N) without replacement, deterministically", () => {
    const s = createAuditSample("run", "v", population, 10, 14);
    expect(s.sampledN).toBe(3);
    expect(new Set(s.items.map((i) => i.evidenceId)).size).toBe(3);
    expect(createAuditSample("run", "v", [...population].reverse(), 10, 14).selectionHash).toBe(s.selectionHash);
    expect(createAuditSample("run", "v", population, 2, 14).sampledN).toBe(2);
  });

  it("appends editions, requires superseding the latest and never treats unreviewed as clean", () => {
    const s = createAuditSample("run", "v", population, 2, 14);
    const item = s.items[0].sampleItemId;
    expect(auditRates(s, [])).toMatchObject({ reviewedK: 0, unreviewed: 2, leakRate: null, leakOrUnsureRate: null });
    const first = appendVerdict(s, [], { sampleItemId: item, verdict: "unsure", notes: "", supersedesId: null, createdAt: "2026-01-01T00:00:00Z", editionId: "v1" });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(appendVerdict(s, first.editions, { sampleItemId: item, verdict: "leak", notes: "", supersedesId: null, createdAt: "2026-01-02T00:00:00Z", editionId: "v2" })).toEqual({ ok: false, code: "frozen_or_mismatch" });
    const second = appendVerdict(s, first.editions, { sampleItemId: item, verdict: "leak", notes: "", supersedesId: "v1", createdAt: "2026-01-02T00:00:00Z", editionId: "v2" });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.editions).toHaveLength(2);
    expect(second.editions[1]).toMatchObject({ edition: 2, supersedesId: "v1" });
    expect(auditRates(s, second.editions)).toMatchObject({ reviewedK: 1, unreviewed: 1, leak: 1, leakRate: 1, leakOrUnsureRate: 1, sampledN: 2, populationN: 3 });
  });
});
