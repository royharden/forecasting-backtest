/**
 * Private account persistence through Bolt Database (Supabase) RPCs and RLS reads.
 * Frozen truth is written only by RPCs (finalize_dataset, freeze_run, finalize_run,
 * create_audit_sample, append_audit_verdict) and by the forecast edge function; the browser never
 * writes frozen tables, live origins, counters or selected attempts. Written under Dirty Mode;
 * never executed against a database.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  buildForecastInput,
  buildMessages,
  createAuditSample,
  freezeRun,
  gateForQuestion,
  hashCanonical,
  recomputeVersionHash,
  rederiveArm,
  replayMissAttempt,
  scoreRun,
  type AttemptRecord,
  type AuditSample,
  type DatasetVersion,
  type FrozenQuestion,
  type GateResult,
  type ModelArm,
  type ModelProfile,
  type QuestionExecution,
  type RecordedAttempt,
  type RunExecution,
  type RunManifest,
  type RunMode,
  type RunStatus,
  type Verdict,
  type VerdictEdition,
} from "../../supabase/functions/_shared/engine.ts";
import { nowUtc, type LoadedDataset, type RunRecord } from "./session";
import { getSupabase } from "./supabaseClient";

export type StoredVersionSummary = { id: string; name: string; kind: string; versionHash: string; frozenAt: string };
export type StoredRunSummary = { id: string; status: string; mode: string; createdAt: string };

function client(): SupabaseClient {
  const supabase = getSupabase();
  if (supabase == null) throw new Error("Bolt Database is not configured; this browser session stores nothing.");
  return supabase;
}

async function userId(supabase: SupabaseClient): Promise<string> {
  const { data, error } = await supabase.auth.getUser();
  if (error != null || data.user == null) throw new Error("Sign in first.");
  return data.user.id;
}

function raise(error: { message: string; details?: string | null } | null, action: string): void {
  if (error != null) throw new Error(`${action}: ${error.message}${error.details ? ` (${error.details})` : ""}`);
}

/** Store a loaded version: a study_sets envelope plus one atomic finalize_dataset call. */
export async function finalizeDatasetRemote(dataset: LoadedDataset): Promise<string> {
  const supabase = client();
  const owner = await userId(supabase);
  const draftId = crypto.randomUUID();
  const { error: setError } = await supabase.from("study_sets").insert({ id: draftId, user_id: owner, name: dataset.version.name });
  raise(setError, "Could not create the draft workspace");
  const { data, error } = await supabase.rpc("finalize_dataset", {
    p_draft_id: draftId,
    p_version: { ...dataset.version, recordings: dataset.recordings, recordingsHash: dataset.recordingsHash },
    p_version_hash: dataset.version.versionHash,
  });
  raise(error, "Could not finalize the dataset version (nothing was committed)");
  return data as string;
}

export async function listStoredVersions(): Promise<StoredVersionSummary[]> {
  const { data, error } = await client().from("dataset_versions").select("id, name, kind, version_hash, frozen_at").order("frozen_at", { ascending: false });
  raise(error, "Could not list stored versions");
  return (data ?? []).map((row) => ({ id: row.id, name: row.name, kind: row.kind, versionHash: row.version_hash, frozenAt: row.frozen_at }));
}

/** Rebuild the engine DatasetVersion from header + row_doc rows and re-check its engine hash. */
export async function loadStoredVersion(id: string): Promise<LoadedDataset> {
  const supabase = client();
  const [header, questions, outcomes, evidence, prices, quarantine, recordings] = await Promise.all([
    supabase.from("dataset_versions").select("header, recordings_hash").eq("id", id).single(),
    supabase.from("version_questions").select("question_key, row_doc").eq("dataset_version_id", id).order("ordinal"),
    supabase.from("version_outcomes").select("question_key, outcome_raw, resolution_audit_text").eq("dataset_version_id", id),
    supabase.from("version_evidence").select("row_doc").eq("dataset_version_id", id).order("ordinal"),
    supabase.from("version_prices").select("row_doc").eq("dataset_version_id", id).order("ordinal"),
    supabase.from("version_quarantine").select("row_doc").eq("dataset_version_id", id).order("ordinal"),
    supabase.from("version_recordings").select("row_doc").eq("dataset_version_id", id).order("ordinal"),
  ]);
  for (const result of [header, questions, outcomes, evidence, prices, quarantine, recordings]) raise(result.error, "Could not load the stored version");
  const outcomeByKey = new Map((outcomes.data ?? []).map((row) => [row.question_key as string, row]));
  const version = {
    ...(header.data?.header as Omit<DatasetVersion, "questions" | "evidence" | "marketObservations" | "quarantine">),
    questions: (questions.data ?? []).map((row) => {
      const outcome = outcomeByKey.get(row.question_key as string);
      return {
        ...(row.row_doc as FrozenQuestion),
        outcome: outcome?.outcome_raw == null ? null : Number(outcome.outcome_raw),
        resolutionAuditText: (outcome?.resolution_audit_text as string | undefined) ?? "",
      };
    }),
    evidence: (evidence.data ?? []).map((row) => row.row_doc),
    marketObservations: (prices.data ?? []).map((row) => row.row_doc),
    quarantine: (quarantine.data ?? []).map((row) => row.row_doc),
  } as DatasetVersion;
  if (recomputeVersionHash(version) !== version.versionHash) {
    throw new Error("The stored rows do not recompute to the stored engine version hash. The version is shown as mismatched and was not loaded.");
  }
  const recorded = (recordings.data ?? []).map((row) => row.row_doc as RecordedAttempt);
  const recordingsHash = (header.data?.recordings_hash as string | null) ?? hashCanonical(recorded);
  if (hashCanonical(recorded) !== recordingsHash) throw new Error("Stored recordings do not match their hash.");
  return { version, recordings: recorded, recordingsHash, source: "account", warnings: [], storedVersionId: id };
}

export async function fetchEnabledProfiles(): Promise<ModelProfile[]> {
  const { data, error } = await client().from("model_profiles").select("profile").eq("enabled", true);
  raise(error, "Could not read model profiles");
  return (data ?? []).map((row) => row.profile as ModelProfile);
}

/** Freeze locally with the pure engine, then let freeze_run re-derive and pin it atomically. */
export async function freezeRunRemote(dataset: LoadedDataset, mode: RunMode, profile: ModelProfile | null): Promise<RunManifest> {
  if (dataset.storedVersionId == null) throw new Error("Store the version on your account first.");
  const frozen = freezeRun(dataset.version, {
    runId: crypto.randomUUID(),
    createdAt: nowUtc(),
    mode,
    profile,
    allowlist: profile == null ? [] : [profile.modelId],
    recordingsHash: dataset.recordingsHash,
  });
  if (!frozen.ok) throw new Error(`${frozen.code}: ${frozen.reasons.join("; ")}`);
  const { error } = await client().rpc("freeze_run", {
    p_dataset_version_id: dataset.storedVersionId,
    p_model_profile_version: profile?.profileVersion ?? null,
    p_protocol_hash: dataset.version.protocolHash,
    p_manifest: frozen.manifest,
    p_manifest_hash: frozen.manifest.manifestHash,
    p_mode: mode,
  });
  raise(error, "Could not freeze the run");
  return frozen.manifest;
}

export async function finalizeRunRemote(runId: string): Promise<string> {
  const { data, error } = await client().rpc("finalize_run", { p_run_id: runId });
  raise(error, "Could not finalize the run");
  return data as string;
}

export async function listStoredRuns(versionId: string): Promise<StoredRunSummary[]> {
  const { data, error } = await client().from("runs").select("id, status, mode, created_at").eq("dataset_version_id", versionId).order("created_at", { ascending: false });
  raise(error, "Could not list stored runs");
  return (data ?? []).map((row) => ({ id: row.id, status: row.status, mode: row.mode, createdAt: row.created_at }));
}

type AttemptRow = { question_key: string; arm: ModelArm; sequence: number; record: AttemptRecord & Record<string, unknown> };

/** Keep only engine AttemptRecord fields so hashes match the pure engine's records. */
function engineAttempt(record: AttemptRecord): AttemptRecord {
  return {
    attemptId: record.attemptId,
    questionId: record.questionId,
    arm: record.arm,
    sequence: record.sequence,
    kind: record.kind,
    origin: record.origin,
    requestHash: record.requestHash,
    promptEvidenceHash: record.promptEvidenceHash,
    evaluation: record.evaluation,
    auditFlags: record.auditFlags,
    model: record.model,
    rawText: record.rawText,
  };
}

/** Reopen a stored run: rebuild the execution from frozen rows and recompute scores with the engine. */
export async function loadStoredRun(runId: string, dataset: LoadedDataset): Promise<RunRecord> {
  const supabase = client();
  const [run, manifestRow, evidenceRows, attemptRows, itemRows] = await Promise.all([
    supabase.from("runs").select("status").eq("id", runId).single(),
    supabase.from("run_manifests").select("manifest").eq("run_id", runId).single(),
    supabase.from("run_prompt_evidence").select("question_key, prompt_evidence, prompt_evidence_hash, ledger, funnel").eq("run_id", runId),
    supabase.from("run_arm_attempts").select("question_key, arm, sequence, record").eq("run_id", runId).order("sequence"),
    supabase.from("run_items").select("question_key, arm, state, reason_code").eq("run_id", runId),
  ]);
  for (const result of [run, manifestRow, evidenceRows, attemptRows, itemRows]) raise(result.error, "Could not load the stored run");
  const manifest = manifestRow.data?.manifest as RunManifest;
  if (manifest.datasetVersionHash !== dataset.version.versionHash) throw new Error("This run belongs to a different dataset version.");
  const attempts = (attemptRows.data ?? []) as AttemptRow[];

  const items: QuestionExecution[] = manifest.evaluationIds.map((questionId) => {
    const question = dataset.version.questions.find((q) => q.id === questionId) as FrozenQuestion;
    const stored = (evidenceRows.data ?? []).find((row) => row.question_key === questionId);
    const recomputed = gateForQuestion(dataset.version, question);
    const gate: GateResult =
      stored == null
        ? recomputed
        : {
            ...recomputed,
            ledger: stored.ledger,
            promptEvidence: stored.prompt_evidence,
            promptEvidenceHash: stored.prompt_evidence_hash,
            funnel: stored.funnel,
          };
    const arms = {} as QuestionExecution["arms"];
    for (const arm of ["no_research", "research"] as const) {
      const records = attempts.filter((a) => a.question_key === questionId && a.arm === arm).map((a) => engineAttempt(a.record));
      const item = (itemRows.data ?? []).find((row) => row.question_key === questionId && row.arm === arm);
      const terminal = item != null && item.state !== "pending" && item.state !== "leased";
      if (manifest.mode === "replay" && terminal && rederiveArm(questionId, arm, gate.promptEvidence.length, records).state === "pending") {
        const sequence = (records.length + 1) as 1 | 2;
        const previous = records[records.length - 1];
        const feedback = previous != null && previous.evaluation.status === "withheld" ? previous.evaluation.feedback : null;
        const kind = sequence === 1 ? "first" : feedback != null ? "correction" : "retry";
        const input = buildForecastInput({ id: question.id, questionTextAsOf: question.questionTextAsOf, resolutionRulesAsOf: question.resolutionRulesAsOf, cutoffAt: question.cutoffAt ?? "" }, gate.promptEvidence, arm);
        records.push(replayMissAttempt(runId, questionId, arm, sequence, kind, hashCanonical(buildMessages(input, feedback)), gate.promptEvidenceHash));
      }
      arms[arm] = rederiveArm(questionId, arm, gate.promptEvidence.length, records);
    }
    return { questionId, gate, arms };
  });
  const execution: RunExecution = { runId, manifestHash: manifest.manifestHash, status: run.data?.status as RunStatus, items };
  const report = scoreRun(dataset.version, manifest, execution);
  const audit = await loadAuditSample(runId, dataset.version.versionHash, execution);
  return { manifest, execution, report, auditSample: audit?.sample ?? null, editions: audit?.editions ?? [], storedRunId: runId };
}

function keptPopulation(execution: RunExecution) {
  return execution.items.flatMap((item) => item.gate.ledger.filter((d) => d.decision === "kept").map((d) => ({ questionId: d.questionId, evidenceId: d.evidenceId })));
}

/**
 * Read the stored sample and check parity with the pure engine sampler: the server's selection
 * must equal createAuditSample() on the same population, seed and size.
 */
async function loadAuditSample(runId: string, versionHash: string, execution: RunExecution, sampleId?: string): Promise<{ sample: AuditSample; editions: VerdictEdition[] } | null> {
  const supabase = client();
  let query = supabase.from("audit_samples").select("id, seed, requested_n, selected").eq("run_id", runId);
  if (sampleId != null) query = query.eq("id", sampleId);
  const { data: rows, error } = await query.order("created_at", { ascending: false }).limit(1);
  raise(error, "Could not load the audit sample");
  const row = rows?.[0];
  if (row == null) return null;
  const engine = createAuditSample(runId, versionHash, keptPopulation(execution), row.requested_n, Number(row.seed));
  const selected = row.selected as [string, string][];
  if (hashCanonical(selected) !== hashCanonical(engine.items.map((i) => [i.questionId, i.evidenceId]))) {
    throw new Error("Stored audit sample differs from the engine sampler for the same seed; it is not shown as valid.");
  }
  const { data: items, error: itemsError } = await supabase.from("audit_sample_items").select("id, position").eq("sample_id", row.id).order("position");
  raise(itemsError, "Could not load audit sample items");
  const ids = new Map((items ?? []).map((item) => [item.position as number, item.id as string]));
  const sample: AuditSample = { ...engine, items: engine.items.map((item) => ({ ...item, sampleItemId: ids.get(item.position) ?? item.sampleItemId })) };
  const { data: editions, error: editionError } = await supabase
    .from("audit_verdict_editions")
    .select("id, sample_item_id, edition, verdict, notes, supersedes_id, created_at")
    .in("sample_item_id", [...ids.values()])
    .order("edition");
  raise(editionError, "Could not load verdict editions");
  return {
    sample,
    editions: (editions ?? []).map((e) => ({
      editionId: e.id,
      sampleItemId: e.sample_item_id,
      edition: e.edition,
      verdict: e.verdict,
      notes: e.notes,
      supersedesId: e.supersedes_id,
      createdAt: e.created_at,
    })),
  };
}

/** Server-side fixed sample (idempotent on run/version/seed/size/algorithm), checked against the engine. */
export async function createAuditSampleRemote(runId: string, versionHash: string, requestedN: number, seed: number, execution?: RunExecution): Promise<AuditSample> {
  const { data, error } = await client().rpc("create_audit_sample", { p_run_id: runId, p_requested_n: requestedN, p_seed: seed });
  raise(error, "Could not create the audit sample");
  if (execution == null) throw new Error("Reopen the stored run before sampling.");
  const loaded = await loadAuditSample(runId, versionHash, execution, data as string);
  if (loaded == null) throw new Error("The new audit sample could not be read back.");
  return loaded.sample;
}

/** Append-only verdict edition; returns the item's refreshed edition history for the sample. */
export async function appendAuditVerdictRemote(
  sample: AuditSample,
  sampleItemId: string,
  verdict: Exclude<Verdict, "unreviewed">,
  notes: string,
  supersedesId: string | null,
): Promise<VerdictEdition[]> {
  const supabase = client();
  const { error } = await supabase.rpc("append_audit_verdict", { p_sample_item_id: sampleItemId, p_verdict: verdict, p_notes: notes, p_supersedes_id: supersedesId });
  raise(error, "Could not append the verdict");
  const { data, error: readError } = await supabase
    .from("audit_verdict_editions")
    .select("id, sample_item_id, edition, verdict, notes, supersedes_id, created_at")
    .in("sample_item_id", sample.items.map((i) => i.sampleItemId))
    .order("edition");
  raise(readError, "Could not reload verdict editions");
  return (data ?? []).map((e) => ({
    editionId: e.id,
    sampleItemId: e.sample_item_id,
    edition: e.edition,
    verdict: e.verdict,
    notes: e.notes,
    supersedesId: e.supersedes_id,
    createdAt: e.created_at,
  }));
}
