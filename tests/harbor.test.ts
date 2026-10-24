// Authored under Dirty Mode; not executed yet. Expected Harbor numbers are hand-derived in comments.
import { describe, expect, it } from "vitest";
import {
  asOfScopeHash,
  buildBundle,
  createAuditSample,
  freezeRun,
  funnelBalances,
  importManifest,
  replayRun,
  redactBundle,
  scoreRun,
  verifyBundle,
  type DatasetVersion,
  type RecordedAttempt,
} from "../supabase/functions/_shared/engine.ts";
import { harborManifestValue } from "../src/lib/demoPack.ts";

const NOW = "2026-10-23T00:00:00.000Z";

function load(mutate?: (m: Record<string, any>) => void): { version: DatasetVersion; recordings: RecordedAttempt[]; recordingsHash: string } {
  const value = harborManifestValue() as Record<string, any>;
  mutate?.(value);
  const result = importManifest(value, NOW);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result;
}

function replay(mutate?: (m: Record<string, any>) => void) {
  const { version, recordings, recordingsHash } = load(mutate);
  const frozen = freezeRun(version, { runId: "run-1", createdAt: NOW, mode: "replay", profile: null, allowlist: [], recordingsHash });
  if (!frozen.ok) throw new Error(frozen.code);
  const execution = replayRun(version, frozen.manifest, recordings);
  const report = scoreRun(version, frozen.manifest, execution);
  return { version, manifest: frozen.manifest, execution, report };
}

describe("Harbor recorded replay", () => {
  const { execution, report } = replay();
  const item = (id: string) => report.items.find((i) => i.questionId === id);

  it("gates sources with balanced funnels", () => {
    const funnels = Object.fromEntries(execution.items.map((i) => [i.questionId, i.gate.funnel]));
    for (const f of Object.values(funnels)) expect(funnelBalances(f)).toBe(true);
    expect(funnels.q1).toMatchObject({ raw: 2, kept: 1, drops: { blocklisted_source: 1 } });
    expect(funnels.q2).toMatchObject({ raw: 2, kept: 1, drops: { blocklisted_source: 1 } });
    expect(funnels.q3).toMatchObject({ raw: 3, kept: 1, drops: { published_after_cutoff: 1, duplicate_content: 1 } });
    expect(funnels.q4).toMatchObject({ raw: 3, kept: 1, drops: { undated: 1, update_marker: 1 } });
    expect(execution.status).toBe("completed");
    expect(funnels.q5).toMatchObject({ raw: 1, kept: 0, drops: { published_after_cutoff: 1 } });
    expect(funnels.q6).toMatchObject({ raw: 3, kept: 2, drops: { version_unavailable: 1 } });
  });

  it("selects research only from valid supported attempts", () => {
    expect(report.reasonCounts.research).toEqual({ insufficient_evidence: 1, valid: 3, withheld_audit: 1, withheld_unsupported_claims: 1 });
    expect(item("q2")?.research).toMatchObject({ state: "withheld", probability: null, withheldProbability: 0.61, reasonCode: "withheld_audit" });
    expect(item("q3")?.research).toMatchObject({ state: "done", probability: 0.35 });
    expect(item("q4")?.research).toMatchObject({ state: "withheld", probability: null, withheldProbability: 0.52 });
    expect(item("q5")?.research).toMatchObject({ state: "skipped", reasonCode: "insufficient_evidence" });
    const q4 = execution.items.find((i) => i.questionId === "q4");
    expect(q4?.arms.research.chargedCalls).toBe(2);
    expect(q4?.arms.research.attempts.map((a) => a.kind)).toEqual(["first", "correction"]);
  });

  it("records the policy tier on every item", () => {
    expect(report.policy.tierCounts).toEqual({ research: 3, no_research: 3, half: 0 });
    expect(report.items.map((i) => [i.questionId, i.policy.tier, i.policy.probability])).toEqual([
      ["q1", "research", 0.7],
      ["q2", "no_research", 0.48],
      ["q3", "research", 0.35],
      ["q4", "no_research", 0.44],
      ["q5", "no_research", 0.66],
      ["q6", "research", 0.2],
    ]);
  });

  it("shows market and base-rate missingness instead of filling it", () => {
    expect(report.reasonCounts.market).toEqual({ ambiguous: 1, ok: 4, stale: 1 });
    expect(report.cohorts.marketPaired).toEqual(["q1", "q2", "q3", "q5"]);
    expect(report.marketMissingN).toBe(2);
    expect(report.reasonCounts.baseRate).toEqual({ unavailable: 6 });
    expect(report.arms.baseRate.n).toBe(0);
    expect(report.cohorts.completeCase).toEqual([]);
  });

  it("computes policy-minus-market on the market-paired cohort", () => {
    // q1 .09-.0784=.0116; q2 .2304-.0484=.182; q3 .4225-.36=.0625; q5 .1156-.0361=.0795; mean .0839
    expect(report.primary.n).toBe(4);
    expect(report.primary.meanDifference).toBeCloseTo(0.0839, 12);
    expect(report.primary.interval).toBeNull();
    // Strict research vs market on q1, q3: (.0116 + .0625)/2 = .03705
    expect(report.secondary.ids).toEqual(["q1", "q3"]);
    expect(report.secondary.meanDifference).toBeCloseTo(0.03705, 12);
    expect(report.caution).toMatch(/Synthetic/);
  });

  it("scores the policy on all six items and the conditional research on three", () => {
    // Policy losses: .09, .2304, .4225, .1936, .1156, .04 -> sum 1.0921 / 6
    expect(report.policy.all.n).toBe(6);
    expect(report.policy.all.brier).toBeCloseTo(1.0921 / 6, 12);
    expect(report.arms.research.n).toBe(3);
    expect(report.arms.half.brier).toBe(0.25);
  });
});

describe("prompt invariance across the whole run", () => {
  it("keeps every request hash when outcomes, audit sentences and prices change", () => {
    const a = replay();
    const b = replay((m) => {
      for (const q of m.questions) {
        q.outcome = q.outcome === 1 ? 0 : 1;
        q.resolutionAuditText = "Something entirely different happened.";
      }
      for (const o of m.marketObservations) o.yesProbability = 0.5;
    });
    const hashes = (run: ReturnType<typeof replay>) =>
      run.execution.items.flatMap((i) => [...i.arms.no_research.attempts, ...i.arms.research.attempts].map((x) => [x.attemptId, x.requestHash, x.promptEvidenceHash]));
    expect(hashes(b)).toEqual(hashes(a));
  });
});

describe("hidden fields never steer correction or keys", () => {
  it("still requests the same correction when a structurally failed attempt also trips the outcome sentence", () => {
    const a = replay();
    // q3's first research attempt fails structurally; make its rationale equal the hidden audit sentence.
    const b = replay((m) => {
      const q3 = m.questions.find((q: { id: string }) => q.id === "q3");
      q3.resolutionAuditText = "A wing still described as a site in July is unlikely to be ready quickly.";
    });
    const research = (run: ReturnType<typeof replay>) => run.execution.items.find((i) => i.questionId === "q3")?.arms.research;
    expect(research(b)?.attempts.map((x) => [x.kind, x.requestHash])).toEqual(research(a)?.attempts.map((x) => [x.kind, x.requestHash]));
    expect(research(b)?.attempts).toHaveLength(2);
    // The selected correction repeats the sentence too: withheld after selection, with no third call.
    expect(research(b)).toMatchObject({ state: "withheld", reasonCode: "withheld_audit", withheldProbability: 0.35, chargedCalls: 2 });
    expect(research(a)).toMatchObject({ state: "done", probability: 0.35 });
  });

  it("keeps the request-key scope when outcomes, audit text and prices change", () => {
    const a = replay();
    const b = replay((m) => {
      for (const q of m.questions) {
        q.outcome = q.outcome === 1 ? 0 : 1;
        q.resolutionAuditText = "Different.";
      }
      for (const o of m.marketObservations) o.yesProbability = 0.01;
    });
    expect(asOfScopeHash(b.version)).toBe(asOfScopeHash(a.version));
    expect(b.version.versionHash).not.toBe(a.version.versionHash);
  });
});

describe("replay-only mode", () => {
  it("returns replay_miss and never invents an output when a recording is missing", () => {
    const { execution } = replay((m) => {
      m.recordedAttempts = m.recordedAttempts.filter((r: { id: string }) => r.id !== "a1n");
    });
    const q1 = execution.items.find((i) => i.questionId === "q1");
    expect(q1?.arms.no_research).toMatchObject({ state: "failed", reasonCode: "replay_miss", probability: null });
    expect(q1?.arms.research.state).toBe("done");
    expect(execution.status).toBe("partial");
  });
});

describe("export and Verify bundle", () => {
  const run = replay();
  const sample = createAuditSample(
    run.manifest.runId,
    run.version.versionHash,
    run.execution.items.flatMap((i) => i.gate.ledger.filter((d) => d.decision === "kept").map((d) => ({ questionId: d.questionId, evidenceId: d.evidenceId }))),
    4,
    14,
  );
  const bundle = buildBundle(run.version, run.manifest, run.execution, run.report, { sample, editions: [] }, NOW);

  it("verifies an untouched bundle after a JSON round trip", () => {
    const result = verifyBundle(JSON.parse(JSON.stringify(bundle)));
    expect(result.checks.filter((c) => !c.ok)).toEqual([]);
    expect(result).toMatchObject({ ok: true, reproducible: true });
  });

  it("detects a single changed row", () => {
    const tampered = JSON.parse(JSON.stringify(bundle));
    tampered.dataset.questions[0].outcome = 0;
    const result = verifyBundle(tampered);
    expect(result.ok).toBe(false);
    expect(result.checks.find((c) => c.name === "dataset version hash")?.ok).toBe(false);

    const metrics = JSON.parse(JSON.stringify(bundle));
    metrics.report.items[0].policy.probability = 0.71;
    const metricsResult = verifyBundle(metrics);
    expect(metricsResult.ok).toBe(false);
    expect(metricsResult.checks.find((c) => c.name === "metrics")?.ok).toBe(false);
  });

  it("marks a rights-redacted bundle as not fully reproducible", () => {
    const redacted = redactBundle(bundle, ["e1"]);
    const result = verifyBundle(JSON.parse(JSON.stringify(redacted)));
    expect(result.reproducible).toBe(false);
    expect(redacted.redaction.missingContentHashes).toHaveLength(1);
    expect(JSON.stringify(redacted)).not.toContain("the deck work was still on the published schedule");
  });
});
