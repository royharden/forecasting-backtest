import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  appendVerdict, auditRates, brier, brierSkillVsHalf, calibrationBins, canonicalJson,
  clusterBootstrap, createAuditSample, expectedCalibrationError, intervalGate,
  logLoss, murphySplit, percentile, sha256Hex, type ScoredPair,
} from "../../supabase/functions/_shared/engine.ts";

const pair = (probability: number, outcome: 0 | 1, i = 0): ScoredPair =>
  ({ questionId: `v${i}`, clusterId: `c${i}`, probability, outcome });

describe("RV independent arithmetic vectors — PLAN §3", () => {
  it("what_bug_this_catches: wrong loss sign, rounding, or half reference", () => {
    const rows = [pair(.8, 1), pair(.3, 0, 1)];
    expect(brier(rows)).toBeCloseTo(.065, 14);
    expect(brierSkillVsHalf(rows)).toBeCloseTo(.74, 14);
    expect(logLoss(rows)).toBeCloseTo(-Math.log(.56) / 2, 14);
  });
  it("what_bug_this_catches: clipping raw Brier along with log loss", () => {
    const rows = [pair(0, 1), pair(1, 0, 1)];
    expect(brier(rows)).toBe(1);
    expect(logLoss(rows)).toBeCloseTo(-Math.log(1e-6), 8);
    for (const p of [NaN, Infinity, -.01, 1.01]) expect(() => brier([pair(p, 0)])).toThrow();
  });
  it.each([5, 10])("what_bug_this_catches: p=1 lost or boundary assigned left (%i bins)", bins => {
    const rows = Array.from({ length: bins + 1 }, (_, i) => pair(i / bins, 0, i));
    const result = calibrationBins(rows, bins);
    expect(result.map(b => b.count)).toEqual([...Array(bins - 1).fill(1), 2]);
    expect(result.reduce((n, b) => n + b.count, 0)).toBe(bins + 1);
  });
  it("what_bug_this_catches: claiming binned Murphy equals raw Brier", () => {
    // Both forecasts in [0,.2): mean p=.1, mean y=.5. Raw loss .365;
    // bin replacement loss .41; reliability .16, resolution 0, uncertainty .25.
    const rows = [pair(.05, 0), pair(.15, 1, 1)];
    expect(brier(rows)).toBeCloseTo(.365, 14);
    expect(expectedCalibrationError(rows, 5)).toBeCloseTo(.4, 14);
    expect(murphySplit(rows, 5)).toMatchObject({ resolution: 0, uncertainty: .25 });
    expect(murphySplit(rows, 5)?.reliability).toBeCloseTo(.16, 14);
    expect(murphySplit(rows, 5)?.binnedBrier).toBeCloseTo(.41, 14);
  });
  it("what_bug_this_catches: equal weighting of unequal-size clusters", () => {
    // Two cluster draws: AA -> 0, AB/BA -> 3/4, BB -> 1. Thus every
    // replicate belongs to {0,.75,1}; percentile endpoints at B=2000 are 0,1.
    const rows = [0, 1, 1, 1].map((difference, i) => ({
      questionId: `q${i}`, clusterId: i === 0 ? "a" : "b", difference,
    }));
    const result = clusterBootstrap(rows, 14);
    expect(result).toMatchObject({ estimate: .75, lower: 0, upper: 1, itemCount: 4, clusterCount: 2, replicates: 2000 });
    expect(clusterBootstrap([...rows].reverse(), 14)).toEqual(result);
    expect(percentile([0, 10, 20, 30], .025)).toBeCloseTo(.75, 14);
    expect(() => clusterBootstrap(rows, 0)).toThrow();
    expect(intervalGate("real", rows).available).toBe(false);
    expect(intervalGate("synthetic", rows).available).toBe(false);
  });
});

describe("RV independent hash and audit contracts — PLAN §4", () => {
  it("what_bug_this_catches: UTF-16 rather than UTF-8 hashes or noncanonical objects", () => {
    for (const text of ["", "abc", "snow ☃ and astral 😀", "x".repeat(1000)]) {
      expect(sha256Hex(text)).toBe(createHash("sha256").update(text, "utf8").digest("hex"));
    }
    expect(canonicalJson({ z: -0, a: [2, 1] })).toBe('{"a":[2,1],"z":0}');
    for (const value of [undefined, { bad: undefined }, NaN, Infinity]) expect(() => canonicalJson(value)).toThrow();
  });
  it("what_bug_this_catches: unreviewed treated as clean, or corrections overwrite history", () => {
    const population = Array.from({ length: 4 }, (_, i) => ({ questionId: "q", evidenceId: `e${i}` }));
    const sample = createAuditSample("rv-run", "version", population, 20, 14);
    expect(sample.sampledN).toBe(4);
    expect(new Set(sample.items.map(i => i.evidenceId)).size).toBe(4);
    expect(createAuditSample("rv-run", "version", [...population].reverse(), 20, 14)).toEqual(sample);
    expect(auditRates(sample, [])).toMatchObject({ reviewedK: 0, unreviewed: 4, leakRate: null, leakOrUnsureRate: null });
    const first = appendVerdict(sample, [], { sampleItemId: sample.items[0].sampleItemId,
      verdict: "leak", notes: "synthetic", supersedesId: null, createdAt: "2026-10-26T00:00:00Z", editionId: "one" });
    if (!first.ok) throw new Error(first.code);
    expect(auditRates(sample, first.editions)).toMatchObject({ reviewedK: 1, unreviewed: 3, leakRate: 1 });
    const second = appendVerdict(sample, first.editions, { sampleItemId: sample.items[0].sampleItemId,
      verdict: "unsure", notes: "correction", supersedesId: "one", createdAt: "2026-10-26T00:01:00Z", editionId: "two" });
    if (!second.ok) throw new Error(second.code);
    expect(first.editions).toHaveLength(1);
    expect(second.editions).toHaveLength(2);
    expect(auditRates(sample, second.editions)).toMatchObject({ reviewedK: 1, unreviewed: 3, leakRate: 0, leakOrUnsureRate: 1 });
    expect(appendVerdict(sample, second.editions, { ...second.editions[1], editionId: "three", supersedesId: "one" }).ok).toBe(false);
  });
});
