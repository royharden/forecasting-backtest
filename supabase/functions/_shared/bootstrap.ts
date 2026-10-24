/**
 * Seeded paired cluster-percentile bootstrap (PLAN.md s.3 "Bootstrap implementation contract").
 *
 * Sort unique cluster IDs, draw K clusters with replacement from K using versioned xorshift32
 * (nonzero uint32 seed, default 14), keep every item of a drawn cluster with its multiplicity,
 * compute the pooled item-weighted mean difference for each of B = 2000 replicates, and take
 * percentile endpoints by linear interpolation at sorted positions (B-1)*0.025 and (B-1)*0.975.
 */

import { hashCanonical } from "./canonical.ts";
import { compareIds } from "./evidence.ts";

export const BOOTSTRAP_ALGORITHM = "xorshift32-cluster-pooled-v1";
export const BOOTSTRAP_QUANTILE_RULE = "linear-interpolation-(B-1)p";
export const DEFAULT_BOOTSTRAP_SEED = 14;
export const BOOTSTRAP_REPLICATES = 2000;

/** xorshift32 (13, 17, 5). Seed must be a nonzero uint32. */
export function xorshift32(seed: number): () => number {
  if (!Number.isInteger(seed) || seed <= 0 || seed > 0xffffffff) throw new Error("xorshift32 seed must be a nonzero uint32.");
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state;
  };
}

/** Uniform-ish index in [0, bound) from the generator (modulo rule; part of the versioned algorithm). */
export function drawIndex(next: () => number, bound: number): number {
  return next() % bound;
}

export function percentile(sortedValues: readonly number[], p: number): number {
  const position = (sortedValues.length - 1) * p;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const weight = position - lower;
  return sortedValues[lower] + (sortedValues[upper] - sortedValues[lower]) * weight;
}

export type PairedItem = { questionId: string; clusterId: string; difference: number };

export type BootstrapInterval = {
  lower: number;
  upper: number;
  estimate: number;
  seed: number;
  replicates: number;
  clusterCount: number;
  itemCount: number;
  algorithm: string;
  quantileRule: string;
  /** Hash of the sorted item/cluster membership; draws are reusable only when this matches exactly. */
  cohortHash: string;
};

export function cohortHash(items: readonly PairedItem[]): string {
  const membership = items
    .map((item) => [item.questionId, item.clusterId])
    .sort((a, b) => compareIds(a[0], b[0]) || compareIds(a[1], b[1]));
  return hashCanonical(membership);
}

/** Pooled item-weighted mean of the differences. */
export function pooledMean(items: readonly PairedItem[]): number {
  return items.reduce((sum, item) => sum + item.difference, 0) / items.length;
}

export function clusterBootstrap(items: readonly PairedItem[], seed = DEFAULT_BOOTSTRAP_SEED, replicates = BOOTSTRAP_REPLICATES): BootstrapInterval {
  if (items.length === 0) throw new Error("Bootstrap needs at least one paired item.");
  const clusterIds = [...new Set(items.map((item) => item.clusterId))].sort(compareIds);
  const sums = new Map<string, { total: number; count: number }>();
  for (const item of items) {
    const entry = sums.get(item.clusterId) ?? { total: 0, count: 0 };
    entry.total += item.difference;
    entry.count += 1;
    sums.set(item.clusterId, entry);
  }
  const next = xorshift32(seed);
  const k = clusterIds.length;
  const values: number[] = [];
  for (let b = 0; b < replicates; b += 1) {
    let total = 0;
    let count = 0;
    for (let draw = 0; draw < k; draw += 1) {
      const entry = sums.get(clusterIds[drawIndex(next, k)]) as { total: number; count: number };
      total += entry.total;
      count += entry.count;
    }
    values.push(total / count);
  }
  values.sort((a, b) => a - b);
  return {
    lower: percentile(values, 0.025),
    upper: percentile(values, 0.975),
    estimate: pooledMean(items),
    seed,
    replicates,
    clusterCount: k,
    itemCount: items.length,
    algorithm: BOOTSTRAP_ALGORITHM,
    quantileRule: BOOTSTRAP_QUANTILE_RULE,
    cohortHash: cohortHash(items),
  };
}

export type IntervalGate = { available: true } | { available: false; reason: string };

/**
 * Display guard: real data, paired n >= 30 and >= 10 distinct event clusters, nonzero variance.
 * Thresholds are display guards, not validity proofs.
 */
export function intervalGate(kind: "synthetic" | "real", items: readonly PairedItem[]): IntervalGate {
  if (kind !== "real") return { available: false, reason: "Synthetic data: arithmetic only, no interval." };
  if (items.length < 30) return { available: false, reason: `Paired n=${items.length} < 30: arithmetic only.` };
  const clusters = new Set(items.map((item) => item.clusterId)).size;
  if (clusters < 10) return { available: false, reason: `${clusters} event cluster(s) < 10: arithmetic only.` };
  const first = items[0].difference;
  if (items.every((item) => item.difference === first)) return { available: false, reason: "Zero-variance differences: interval degenerate." };
  return { available: true };
}
