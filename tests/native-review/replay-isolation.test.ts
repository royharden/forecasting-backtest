import { describe, expect, it } from "vitest";
import {
  buildBundle, buildForecastInput, buildMessages, canonicalJson, freezeRun, gateForQuestion,
  importManifest, replayRun, scoreRun, verifyBundle, type Manifest,
} from "../../supabase/functions/_shared/engine.ts";
import { harborManifestValue } from "../../src/lib/demoPack.ts";

const NOW = "2026-10-26T00:00:00.000Z";
function replay(mutate?: (value: Manifest) => void) {
  const value = harborManifestValue() as Manifest;
  mutate?.(value);
  const imported = importManifest(value, NOW);
  if (!imported.ok) throw new Error(JSON.stringify(imported.errors));
  const frozen = freezeRun(imported.version, { runId: "rv-isolation", createdAt: NOW,
    mode: "replay", profile: null, allowlist: [], recordingsHash: imported.recordingsHash });
  if (!frozen.ok) throw new Error(frozen.code);
  const execution = replayRun(imported.version, frozen.manifest, imported.recordings);
  const report = scoreRun(imported.version, frozen.manifest, execution);
  return { version: imported.version, manifest: frozen.manifest, execution, report };
}

describe("RV request isolation and bundle reproduction — PLAN §2/4", () => {
  it("what_bug_this_catches: hidden scores/audit fields influence first or correction request", () => {
    const original = replay();
    const perturbed = replay(m => {
      for (const q of m.questions) {
        q.outcome = q.outcome === 1 ? 0 : 1;
        q.resolutionAuditText = "RV hidden sentence must never enter a model request.";
      }
      for (const price of m.marketObservations) price.yesProbability = .123;
    });
    let corrections = 0;
    for (const q of original.version.questions.filter(q => q.role === "evaluation")) {
      const changed = perturbed.version.questions.find(other => other.id === q.id)!;
      if (q.cutoffAt == null || changed.cutoffAt == null) throw new Error("Harbor cutoff missing");
      for (const arm of ["no_research", "research"] as const) {
        const a = buildForecastInput({ ...q, cutoffAt: q.cutoffAt }, gateForQuestion(original.version, q).promptEvidence, arm);
        const b = buildForecastInput({ ...changed, cutoffAt: changed.cutoffAt }, gateForQuestion(perturbed.version, changed).promptEvidence, arm);
        expect(canonicalJson(buildMessages(a, null))).toBe(canonicalJson(buildMessages(b, null)));
        expect(canonicalJson(buildMessages(a, [{ claimIndex: 0, code: "unknown_source" }]))).toBe(
          canonicalJson(buildMessages(b, [{ claimIndex: 0, code: "unknown_source" }])));
        if (arm === "no_research") expect(a.evidence).toEqual([]);
        const get = (r: typeof original) => r.execution.items.find(i => i.questionId === q.id)!.arms[arm].attempts;
        expect(get(perturbed).map(x => [x.kind, x.requestHash])).toEqual(get(original).map(x => [x.kind, x.requestHash]));
        corrections += get(original).filter(a => a.kind === "correction").length;
      }
    }
    expect(corrections).toBeGreaterThan(0);
    expect(perturbed.version.versionHash).not.toBe(original.version.versionHash);
  });
  it("what_bug_this_catches: fabricated native output hides missing recordings", () => {
    const missing = replay(m => { m.recordedAttempts = []; });
    expect(missing.report.policy.all.n).toBe(6);
    expect(missing.report.arms.research.n).toBe(0);
    expect(missing.report.arms.noResearch.n).toBe(0);
    expect(missing.report.policy.tierCounts).toEqual({ research: 0, no_research: 0, half: 6 });
    expect(missing.report.policy.all.brier).toBe(.25);
  });
  it("what_bug_this_catches: Verify trusts exported metric or hidden-outcome rows", () => {
    const r = replay();
    const bundle = buildBundle(r.version, r.manifest, r.execution, r.report,
      { sample: null, editions: [] }, NOW);
    expect(verifyBundle(JSON.parse(JSON.stringify(bundle))).ok).toBe(true);
    const altered = JSON.parse(JSON.stringify(bundle)) as typeof bundle;
    altered.dataset.questions[0].outcome = altered.dataset.questions[0].outcome === 1 ? 0 : 1;
    expect(verifyBundle(altered).ok).toBe(false);
    const metrics = JSON.parse(JSON.stringify(bundle)) as typeof bundle;
    metrics.report.policy.all.brier = .00001;
    expect(verifyBundle(metrics).ok).toBe(false);
  });
});
