/**
 * Page-session state for loaded dataset versions and runs. In demo/unsigned mode this is the only
 * store: it lasts for the page session and is gone on reload. Signed-in mode mirrors versions and
 * runs to the database through repository.ts.
 */

import {
  freezeRun,
  replayRun,
  scoreRun,
  type AuditSample,
  type DatasetVersion,
  type ImportIssue,
  type RecordedAttempt,
  type RunExecution,
  type RunManifest,
  type RunReport,
  type VerdictEdition,
} from "../../supabase/functions/_shared/engine.ts";

export type LoadedDataset = {
  version: DatasetVersion;
  recordings: RecordedAttempt[];
  recordingsHash: string;
  source: "demo" | "import" | "account";
  warnings: ImportIssue[];
  /** dataset_versions.id once finalized on the account. */
  storedVersionId: string | null;
};

export type RunRecord = {
  manifest: RunManifest;
  execution: RunExecution;
  report: RunReport;
  auditSample: AuditSample | null;
  editions: VerdictEdition[];
  /** runs.id once stored on the account. */
  storedRunId: string | null;
};

export function nowUtc(): string {
  return new Date().toISOString();
}

/** Freeze a replay run and execute it with recorded outputs only. No provider path exists here. */
export function runRecordedReplay(dataset: LoadedDataset): { ok: true; run: RunRecord } | { ok: false; message: string } {
  const frozen = freezeRun(dataset.version, {
    runId: crypto.randomUUID(),
    createdAt: nowUtc(),
    mode: "replay",
    profile: null,
    allowlist: [],
    recordingsHash: dataset.recordingsHash,
  });
  if (!frozen.ok) return { ok: false, message: `${frozen.code}: ${frozen.reasons.join("; ")}` };
  const execution = replayRun(dataset.version, frozen.manifest, dataset.recordings);
  const report = scoreRun(dataset.version, frozen.manifest, execution);
  return { ok: true, run: { manifest: frozen.manifest, execution, report, auditSample: null, editions: [], storedRunId: null } };
}

export function downloadJson(filename: string, value: unknown): void {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export async function readFileText(file: File, maxBytes: number): Promise<string> {
  if (file.size > maxBytes) throw new Error(`File is ${file.size} bytes; the limit is ${maxBytes}.`);
  return file.text();
}
