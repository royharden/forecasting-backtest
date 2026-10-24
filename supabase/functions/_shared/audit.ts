/**
 * Human audit sampling and append-only verdict editions (PLAN.md s.4 "Exact workflow").
 *
 * Sampling is without replacement from the kept evidence sorted by (questionId, evidenceId),
 * min(requestedN, N) items, with a stored algorithm, seed and selection hash. Verdicts are
 * append-only editions; no event means unreviewed, and unreviewed never counts as clean.
 * This samples supplied evidence; it cannot prove the absence of leakage.
 */

import { hashCanonical } from "./canonical.ts";
import { drawIndex, xorshift32 } from "./bootstrap.ts";
import { compareIds } from "./evidence.ts";

export const AUDIT_SAMPLE_ALGORITHM = "xorshift32-partial-fisher-yates-v1";
export const VERDICTS = ["clean", "leak", "unsure", "unreviewed"] as const;
export type Verdict = (typeof VERDICTS)[number];

export type AuditPopulationItem = { questionId: string; evidenceId: string };

export type AuditSampleItem = { sampleItemId: string; position: number; questionId: string; evidenceId: string };

export type AuditSample = {
  runId: string;
  evidenceVersionHash: string;
  algorithm: string;
  seed: number;
  requestedN: number;
  populationN: number;
  sampledN: number;
  items: AuditSampleItem[];
  selectionHash: string;
};

export function sortPopulation(items: readonly AuditPopulationItem[]): AuditPopulationItem[] {
  return [...items].sort((a, b) => compareIds(a.questionId, b.questionId) || compareIds(a.evidenceId, b.evidenceId));
}

/** Deterministic: the same run, evidence version, seed, requestedN and algorithm give the same sample. */
export function createAuditSample(
  runId: string,
  evidenceVersionHash: string,
  population: readonly AuditPopulationItem[],
  requestedN: number,
  seed: number,
): AuditSample {
  if (!Number.isInteger(requestedN) || requestedN < 1) throw new Error("requestedN must be a positive integer.");
  const sorted = sortPopulation(population);
  const n = Math.min(requestedN, sorted.length);
  const pool = sorted.slice();
  const next = xorshift32(seed);
  for (let i = 0; i < n; i += 1) {
    const j = i + drawIndex(next, pool.length - i);
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const items = pool.slice(0, n).map((item, position) => ({
    sampleItemId: `${runId}:${seed}:${requestedN}:${position}`,
    position,
    questionId: item.questionId,
    evidenceId: item.evidenceId,
  }));
  const selectionHash = hashCanonical({
    runId,
    evidenceVersionHash,
    algorithm: AUDIT_SAMPLE_ALGORITHM,
    seed,
    requestedN,
    population: sorted,
    selected: items.map((item) => [item.questionId, item.evidenceId]),
  });
  return {
    runId,
    evidenceVersionHash,
    algorithm: AUDIT_SAMPLE_ALGORITHM,
    seed,
    requestedN,
    populationN: sorted.length,
    sampledN: n,
    items,
    selectionHash,
  };
}

export type VerdictEdition = {
  editionId: string;
  sampleItemId: string;
  edition: number;
  verdict: Exclude<Verdict, "unreviewed">;
  notes: string;
  supersedesId: string | null;
  createdAt: string;
};

export type AppendVerdictInput = {
  sampleItemId: string;
  verdict: Exclude<Verdict, "unreviewed">;
  notes: string;
  supersedesId: string | null;
  createdAt: string;
  editionId: string;
};

/**
 * Append a verdict edition. A correction must supersede the item's current latest edition; editions
 * are never overwritten or deleted. Returns the new list or an error code.
 */
export function appendVerdict(
  sample: AuditSample,
  editions: readonly VerdictEdition[],
  input: AppendVerdictInput,
): { ok: true; editions: VerdictEdition[] } | { ok: false; code: string } {
  if (!sample.items.some((item) => item.sampleItemId === input.sampleItemId)) return { ok: false, code: "not_found" };
  if (!VERDICTS.includes(input.verdict) || (input.verdict as string) === "unreviewed") return { ok: false, code: "invalid_input" };
  const history = editions.filter((e) => e.sampleItemId === input.sampleItemId).sort((a, b) => a.edition - b.edition);
  const latest = history[history.length - 1];
  if (latest == null && input.supersedesId != null) return { ok: false, code: "invalid_supersedes" };
  if (latest != null && input.supersedesId !== latest.editionId) return { ok: false, code: "frozen_or_mismatch" };
  if (editions.some((e) => e.editionId === input.editionId)) return { ok: false, code: "duplicate_id" };
  return {
    ok: true,
    editions: [
      ...editions,
      {
        editionId: input.editionId,
        sampleItemId: input.sampleItemId,
        edition: (latest?.edition ?? 0) + 1,
        verdict: input.verdict,
        notes: input.notes,
        supersedesId: input.supersedesId,
        createdAt: input.createdAt,
      },
    ],
  };
}

export function currentVerdicts(sample: AuditSample, editions: readonly VerdictEdition[]): Map<string, Verdict> {
  const result = new Map<string, Verdict>();
  for (const item of sample.items) {
    const history = editions.filter((e) => e.sampleItemId === item.sampleItemId).sort((a, b) => a.edition - b.edition);
    result.set(item.sampleItemId, history[history.length - 1]?.verdict ?? "unreviewed");
  }
  return result;
}

export type AuditRates = {
  populationN: number;
  sampledN: number;
  reviewedK: number;
  unreviewed: number;
  clean: number;
  leak: number;
  unsure: number;
  /** leak / k; null when k = 0. */
  leakRate: number | null;
  /** (leak + unsure) / k; null when k = 0. */
  leakOrUnsureRate: number | null;
  judgeAgreement: "not_applicable";
};

export function auditRates(sample: AuditSample, editions: readonly VerdictEdition[]): AuditRates {
  const verdicts = [...currentVerdicts(sample, editions).values()];
  const count = (v: Verdict) => verdicts.filter((x) => x === v).length;
  const leak = count("leak");
  const unsure = count("unsure");
  const clean = count("clean");
  const k = leak + unsure + clean;
  return {
    populationN: sample.populationN,
    sampledN: sample.sampledN,
    reviewedK: k,
    unreviewed: sample.sampledN - k,
    clean,
    leak,
    unsure,
    leakRate: k === 0 ? null : leak / k,
    leakOrUnsureRate: k === 0 ? null : (leak + unsure) / k,
    judgeAgreement: "not_applicable",
  };
}
