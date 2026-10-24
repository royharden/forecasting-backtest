/**
 * Export bundle and Verify bundle (PLAN.md s.4 "Browser Verify bundle is required").
 *
 * Verify validates schema and lineage and recomputes hashes and metrics with this same pure engine.
 * Hash agreement proves reproduction from the supplied rows, not their truth or authenticity, and
 * cannot detect coordinated tampering of every artifact.
 */

import { hashCanonical, sha256Hex } from "./canonical.ts";
import { AUDIT_SAMPLE_ALGORITHM, auditRates, createAuditSample, type AuditRates, type AuditSample, type VerdictEdition } from "./audit.ts";
import { BOOTSTRAP_ALGORITHM, BOOTSTRAP_QUANTILE_RULE } from "./bootstrap.ts";
import type { ArmResult } from "./attempts.ts";
import { evaluateOutput } from "./critic.ts";
import { BLOCKLIST_VERSION, CORE_VERSION, GATE_VERSION, PROMPT_VERSION, SCHEMA_VERSION, recomputeVersionHash, type DatasetVersion } from "./manifest.ts";
import { buildForecastInput, buildMessages } from "./prompt.ts";
import {
  fullExcerptLengthLookup,
  gateForQuestion,
  auditFlagsFor,
  questionById,
  recomputeManifestHash,
  recomputeMetricsHash,
  rederiveArm,
  scoreRun,
  type RunExecution,
  type RunManifest,
  type RunReport,
} from "./run.ts";

export const BUNDLE_SCHEMA = "s14-bundle-1";

export type AuditCompanion = {
  sample: AuditSample | null;
  editions: VerdictEdition[];
  rates: AuditRates | null;
  note: string;
};

export type Redaction = { redacted: boolean; missingContentHashes: string[]; note: string };

export type ExportBundle = {
  bundleSchema: typeof BUNDLE_SCHEMA;
  exportedAt: string;
  versions: {
    schema: number;
    core: string;
    prompt: string;
    gate: string;
    blocklist: string;
    bootstrapAlgorithm: string;
    bootstrapQuantileRule: string;
    auditAlgorithm: string;
  };
  dataset: DatasetVersion;
  run: RunManifest;
  execution: RunExecution;
  report: RunReport;
  audit: AuditCompanion;
  redaction: Redaction;
  qualifications: string[];
  hashes: {
    datasetVersionHash: string;
    runManifestHash: string;
    executionHash: string;
    metricsHash: string;
    auditCompanionHash: string;
    bundleHash: string;
  };
};

export const QUALIFICATIONS = [
  "Supplied-evidence backtest: scores evaluate the supplied evidence and model outputs, not a retrieval service.",
  "Hash agreement proves reproduction from the supplied rows, not truth, authenticity or detection of coordinated tampering.",
  "The deterministic critic checks extraction, dates and provenance, not article truth, semantic entailment or freedom from training memory.",
  "A no-research arm is an ablation, not a memory detector. Synthetic data marks memory checks N/A.",
  "The audit companion samples supplied evidence; it cannot prove the absence of leakage.",
  "Cutoff presets do not remove selection or survivor bias.",
];

export function buildBundle(
  dataset: DatasetVersion,
  run: RunManifest,
  execution: RunExecution,
  report: RunReport,
  audit: { sample: AuditSample | null; editions: VerdictEdition[] },
  exportedAt: string,
): ExportBundle {
  const companion: AuditCompanion = {
    sample: audit.sample,
    editions: audit.editions,
    rates: audit.sample == null ? null : auditRates(audit.sample, audit.editions),
    note: dataset.kind === "synthetic" ? "Synthetic audit workflow: a demonstration, N/A as evidence of real leak detection." : "Human audit of supplied evidence.",
  };
  const body: BundleBody = {
    bundleSchema: BUNDLE_SCHEMA,
    exportedAt,
    versions: {
      schema: SCHEMA_VERSION,
      core: CORE_VERSION,
      prompt: PROMPT_VERSION,
      gate: GATE_VERSION,
      blocklist: BLOCKLIST_VERSION,
      bootstrapAlgorithm: BOOTSTRAP_ALGORITHM,
      bootstrapQuantileRule: BOOTSTRAP_QUANTILE_RULE,
      auditAlgorithm: AUDIT_SAMPLE_ALGORITHM,
    },
    dataset,
    run,
    execution,
    report,
    audit: companion,
    redaction: { redacted: false, missingContentHashes: [], note: "Complete: every permitted excerpt is included." },
    qualifications: [...QUALIFICATIONS],
  };
  return withHashes(body);
}

type BundleBody = Omit<ExportBundle, "hashes">;

function withHashes(body: BundleBody): ExportBundle {
  const partial = {
    datasetVersionHash: body.dataset.versionHash,
    runManifestHash: body.run.manifestHash,
    executionHash: hashCanonical(body.execution),
    metricsHash: body.report.metricsHash,
    auditCompanionHash: hashCanonical(body.audit),
  };
  return { ...body, hashes: { ...partial, bundleHash: hashCanonical({ ...body, hashes: partial }) } };
}

/**
 * Remove excerpt text for evidence the owner may not redistribute. The bundle is then marked not
 * fully reproducible and lists the missing content hashes.
 */
export function redactBundle(bundle: ExportBundle, evidenceIds: readonly string[]): ExportBundle {
  const ids = new Set(evidenceIds);
  const missing = bundle.dataset.evidence.filter((e) => ids.has(e.id)).map((e) => e.contentHash);
  const { hashes: _old, ...body } = bundle;
  void _old;
  return withHashes({
    ...body,
    dataset: { ...body.dataset, evidence: body.dataset.evidence.map((e) => (ids.has(e.id) ? { ...e, excerpt: "" } : e)) },
    execution: {
      ...body.execution,
      items: body.execution.items.map((item) => ({
        ...item,
        gate: { ...item.gate, promptEvidence: item.gate.promptEvidence.map((p) => (ids.has(p.evidenceId) ? { ...p, excerpt: "" } : p)) },
        arms: {
          no_research: redactArm(item.arms.no_research, ids),
          research: redactArm(item.arms.research, ids),
        },
      })),
    },
    redaction: { redacted: true, missingContentHashes: missing, note: "Redacted for rights: not fully reproducible. Missing excerpts are listed by content hash." },
  });
}

/** Claims quote excerpts exactly, so quoted text and raw outputs citing redacted evidence go too. */
function redactArm(arm: ArmResult, ids: ReadonlySet<string>): ArmResult {
  return {
    ...arm,
    attempts: arm.attempts.map((attempt) => {
      const evaluation = attempt.evaluation;
      if (evaluation.status === "failed" || !evaluation.claims.some((c) => ids.has(c.evidenceId))) return attempt;
      return {
        ...attempt,
        rawText: null,
        evaluation: { ...evaluation, claims: evaluation.claims.map((c) => (ids.has(c.evidenceId) ? { ...c, text: "" } : c)) },
      };
    }),
  };
}

export type VerifyCheck ={ name: string; ok: boolean; detail: string };
export type VerifyResult = { ok: boolean; reproducible: boolean; checks: VerifyCheck[]; limitation: string };

const LIMITATION = "Hash agreement proves reproduction from supplied rows, not truth, authenticity or detection of coordinated tampering.";

/** Validate schema and lineage, then recompute hashes and metrics with the pure engine. */
export function verifyBundle(value: unknown): VerifyResult {
  const checks: VerifyCheck[] = [];
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });
  if (value == null || typeof value !== "object") {
    add("schema", false, "Not a JSON object.");
    return { ok: false, reproducible: false, checks, limitation: LIMITATION };
  }
  const bundle = value as ExportBundle;
  if (bundle.bundleSchema !== BUNDLE_SCHEMA || bundle.dataset == null || bundle.run == null || bundle.execution == null || bundle.report == null || bundle.hashes == null) {
    add("schema", false, `Expected ${BUNDLE_SCHEMA} with dataset, run, execution, report and hashes.`);
    return { ok: false, reproducible: false, checks, limitation: LIMITATION };
  }
  add("schema", true, BUNDLE_SCHEMA);

  try {
    const { dataset, run, execution, report } = bundle;
    const redacted = bundle.redaction?.redacted === true;

    const versionHash = recomputeVersionHash(dataset);
    if (redacted) {
      add("dataset version hash", dataset.versionHash === bundle.hashes.datasetVersionHash, "Redacted: the stored hash cannot be recomputed from withheld excerpts.");
    } else {
      add("dataset version hash", versionHash === dataset.versionHash && versionHash === bundle.hashes.datasetVersionHash, versionHash);
    }

    const contentMismatches = dataset.evidence.filter((e) => e.excerpt !== "" && sha256Hex(e.excerpt) !== e.contentHash).map((e) => e.id);
    add("evidence content hashes", contentMismatches.length === 0, contentMismatches.length === 0 ? "All present excerpts match." : `Mismatch: ${contentMismatches.join(", ")}`);

    const manifestHash = recomputeManifestHash(run);
    add("run manifest hash", manifestHash === run.manifestHash && manifestHash === bundle.hashes.runManifestHash, manifestHash);
    add("lineage: run -> dataset", run.datasetVersionHash === dataset.versionHash && run.protocolHash === dataset.protocolHash, "Run references this dataset version and protocol.");
    add("lineage: execution -> run", execution.manifestHash === run.manifestHash && execution.runId === run.runId, "Execution references this run manifest.");
    add("lineage: report -> run", report.manifestHash === run.manifestHash && report.datasetVersionHash === dataset.versionHash, "Report references this run and dataset.");
    add("execution hash", hashCanonical(execution) === bundle.hashes.executionHash, "Execution rows match the bundle hash.");

    if (!redacted) {
      const fullLength = fullExcerptLengthLookup(dataset);
      const gateProblems: string[] = [];
      const attemptProblems: string[] = [];
      for (const item of execution.items) {
        const question = questionById(dataset, item.questionId);
        const gate = gateForQuestion(dataset, question);
        if (gate.promptEvidenceHash !== item.gate.promptEvidenceHash || hashCanonical(gate.ledger) !== hashCanonical(item.gate.ledger)) gateProblems.push(item.questionId);
        for (const arm of ["no_research", "research"] as const) {
          const stored = item.arms[arm];
          for (const attempt of stored.attempts) {
            const input = buildForecastInput({ id: question.id, questionTextAsOf: question.questionTextAsOf, resolutionRulesAsOf: question.resolutionRulesAsOf, cutoffAt: question.cutoffAt ?? "" }, gate.promptEvidence, arm);
            const feedback = attempt.kind === "correction" ? previousFeedback(stored.attempts, attempt.sequence) : null;
            if (hashCanonical(buildMessages(input, feedback)) !== attempt.requestHash) attemptProblems.push(`${attempt.attemptId}:request`);
            if (attempt.rawText != null) {
              const evaluation = evaluateOutput(attempt.rawText, arm, gate.promptEvidence, gate.ledger, fullLength);
              if (hashCanonical(evaluation) !== hashCanonical(attempt.evaluation)) attemptProblems.push(`${attempt.attemptId}:evaluation`);
              if (hashCanonical(auditFlagsFor(arm, evaluation, question)) !== hashCanonical(attempt.auditFlags)) attemptProblems.push(`${attempt.attemptId}:audit`);
            }
          }
          const rederived = rederiveArm(item.questionId, arm, gate.promptEvidence.length, stored.attempts);
          if (hashCanonical(rederived) !== hashCanonical(stored)) attemptProblems.push(`${item.questionId}:${arm}:selection`);
        }
      }
      add("evidence gate and PromptEvidence", gateProblems.length === 0, gateProblems.length === 0 ? "Every ledger and evidence pack recomputes." : `Mismatch: ${gateProblems.join(", ")}`);
      add("attempts, critic and selection", attemptProblems.length === 0, attemptProblems.length === 0 ? "Every request hash, critic decision and selected attempt recomputes." : `Mismatch: ${attemptProblems.join(", ")}`);

      const rescored = scoreRun(dataset, run, execution);
      const same = hashCanonical(rescored) === hashCanonical(report) && report.metricsHash === bundle.hashes.metricsHash;
      add("metrics", same, same ? "Every report field recomputes from the frozen rows." : "Recomputed report differs from the stored report.");
    } else {
      add("metrics", recomputeMetricsHash(report) === report.metricsHash, "Redacted bundle: report hash checked; gate and critic cannot be fully recomputed.");
    }

    const audit = bundle.audit;
    if (audit?.sample != null) {
      const kept = execution.items.flatMap((item) => item.gate.ledger.filter((d) => d.decision === "kept").map((d) => ({ questionId: d.questionId, evidenceId: d.evidenceId })));
      const resampled = createAuditSample(audit.sample.runId, audit.sample.evidenceVersionHash, kept, audit.sample.requestedN, audit.sample.seed);
      add("audit sample", resampled.selectionHash === audit.sample.selectionHash, `Reviewed ${audit.rates?.reviewedK ?? 0} of ${audit.sample.sampledN} sampled from N=${audit.sample.populationN}.`);
      add("audit rates", hashCanonical(auditRates(audit.sample, audit.editions)) === hashCanonical(audit.rates), "Rates recompute from the edition history.");
    }
    add("audit companion hash", hashCanonical(audit) === bundle.hashes.auditCompanionHash, "Audit companion matches the bundle hash.");

    const { hashes, ...body } = bundle;
    const { bundleHash, ...partial } = hashes;
    add("bundle hash", hashCanonical({ ...body, hashes: partial }) === bundleHash, bundleHash);
    if (redacted) add("redaction", false, `Not fully reproducible: ${bundle.redaction.missingContentHashes.length} excerpt(s) withheld for rights.`);
  } catch (error) {
    add("recompute", false, error instanceof Error ? error.message : "Recompute failed.");
  }
  const ok = checks.every((c) => c.ok || c.name === "redaction");
  return { ok, reproducible: ok && bundle.redaction?.redacted !== true, checks, limitation: LIMITATION };
}

function previousFeedback(attempts: RunExecution["items"][number]["arms"]["research"]["attempts"], sequence: number) {
  const previous = attempts.find((a) => a.sequence === sequence - 1);
  return previous != null && previous.evaluation.status === "withheld" ? previous.evaluation.feedback : null;
}
