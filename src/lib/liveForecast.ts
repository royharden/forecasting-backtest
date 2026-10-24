/**
 * Browser driver for account runs (replay or live). It freezes a run, then calls the forecast
 * function once per arm stage while the page is open: no-research to a terminal state first, then
 * research. Closing the page pauses new work (one in-flight provider call may still finish).
 * Written under Dirty Mode; never executed against a deployed function.
 */

import type { ModelArm, ModelProfile, RunManifest, RunMode } from "../../supabase/functions/_shared/engine.ts";
import { readPublicConfig } from "./config";
import { finalizeRunRemote, freezeRunRemote, loadStoredRun } from "./repository";
import type { LoadedDataset, RunRecord } from "./session";
import { getSupabase } from "./supabaseClient";

export type ForecastResponse = {
  runId: string;
  itemId: string;
  attemptId: string | null;
  status: "pending" | "leased" | "done" | "withheld" | "failed" | "skipped";
  reasonCode: string | null;
  retryNotBefore: string | null;
  armPrediction: number | null;
  usageStatus: string;
};

export class ForecastHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const TERMINAL = new Set(["done", "withheld", "failed", "skipped"]);
const MAX_WAIT_MS = 300_000;

async function callForecast(runId: string, questionId: string, arm: ModelArm): Promise<ForecastResponse> {
  const config = readPublicConfig();
  const supabase = getSupabase();
  if (config == null || supabase == null) throw new Error("Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY first.");
  const { data, error } = await supabase.auth.getSession();
  if (error != null) throw new Error(error.message);
  const token = data.session?.access_token;
  if (token == null) throw new Error("Sign in first.");
  let response: Response;
  try {
    response = await fetch(`${config.url}/functions/v1/forecast`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, apikey: config.anonKey, "Content-Type": "application/json" },
      // A fresh request key per call; a permitted retry is a new key and a new slot.
      body: JSON.stringify({ runId, questionId, arm, requestKey: crypto.randomUUID() }),
    });
  } catch (cause) {
    throw new ForecastHttpError(0, "network", `The forecast function could not be reached (${cause instanceof Error ? cause.message : "network error"}).`);
  }
  const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok) {
    throw new ForecastHttpError(response.status, String(payload?.error ?? "error"), String(payload?.message ?? `HTTP ${response.status}`));
  }
  return payload as unknown as ForecastResponse;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error("Paused."));
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error("Paused."));
    });
  });
}

/** Drive one arm to a terminal state, honoring persisted retry_not_before, leases and 409 in_progress. */
async function driveArm(runId: string, questionId: string, arm: ModelArm, signal: AbortSignal): Promise<ForecastResponse> {
  for (let guard = 0; guard < 40; guard += 1) {
    if (signal.aborted) throw new Error("Paused.");
    try {
      const result = await callForecast(runId, questionId, arm);
      if (TERMINAL.has(result.status)) return result;
      // pending: wait for the persisted retry time; leased by another request: give its bounded call time.
      const wait =
        result.retryNotBefore != null
          ? Math.min(MAX_WAIT_MS, Math.max(0, Date.parse(result.retryNotBefore) - Date.now()))
          : result.status === "leased"
            ? 10_000
            : 0;
      await sleep(wait + 250, signal);
    } catch (error) {
      if (error instanceof ForecastHttpError && error.code === "in_progress") {
        await sleep(10_000, signal);
        continue;
      }
      throw error;
    }
  }
  throw new Error(`${questionId}/${arm} did not reach a terminal state; the run stays processing and can be resumed.`);
}

export type RunProgress = (message: string) => void;

const STOP_CODES = new Set(["budget_exhausted", "configuration_required", "manifest_or_config_mismatch"]);

type PassOutcome = { stopped: string | null; paused: boolean };

/**
 * Drive every non-terminal arm of a frozen run, no-research before research per question. Budget
 * or configuration stops end the pass. Nothing is invented for missing arms.
 */
async function driveRun(
  manifest: RunManifest,
  isPending: (questionId: string, arm: ModelArm) => boolean,
  onProgress: RunProgress,
  signal: AbortSignal,
): Promise<PassOutcome> {
  for (const questionId of manifest.evaluationIds) {
    for (const arm of ["no_research", "research"] as const) {
      if (!isPending(questionId, arm)) continue;
      onProgress(`${questionId} · ${arm}`);
      try {
        const result = await driveArm(manifest.runId, questionId, arm, signal);
        onProgress(`${questionId} · ${arm}: ${result.status}${result.reasonCode ? ` (${result.reasonCode})` : ""}`);
      } catch (error) {
        if (signal.aborted) return { stopped: null, paused: true };
        if (error instanceof ForecastHttpError && STOP_CODES.has(error.code)) return { stopped: `${error.code}: ${error.message}`, paused: false };
        throw error;
      }
    }
  }
  return { stopped: null, paused: false };
}

/** A pause leaves the run processing (resumable); any completed or stopped pass finalizes it. */
async function finish(manifest: RunManifest, dataset: LoadedDataset, outcome: PassOutcome, onProgress: RunProgress): Promise<RunRecord> {
  if (outcome.paused) {
    onProgress("Paused. The run stays processing; use Resume on the stored run while this page is open.");
    return loadStoredRun(manifest.runId, dataset);
  }
  const status = await finalizeRunRemote(manifest.runId);
  onProgress(`Run ${status}${outcome.stopped != null ? ` — stopped: ${outcome.stopped}` : ""}`);
  return loadStoredRun(manifest.runId, dataset);
}

/** Freeze a new account run and drive it. */
export async function runOnAccount(dataset: LoadedDataset, mode: RunMode, profile: ModelProfile | null, onProgress: RunProgress, signal: AbortSignal): Promise<RunRecord> {
  const manifest = await freezeRunRemote(dataset, mode, profile);
  return finish(manifest, dataset, await driveRun(manifest, () => true, onProgress, signal), onProgress);
}

/** Resume a stored processing run with its existing manifest: only arms not yet terminal are driven. */
export async function resumeOnAccount(runId: string, dataset: LoadedDataset, onProgress: RunProgress, signal: AbortSignal): Promise<RunRecord> {
  const current = await loadStoredRun(runId, dataset);
  if (current.execution.status !== "processing" && current.execution.status !== "created") {
    throw new Error("Only a processing run can resume; a terminal run needs a new linked run.");
  }
  const pending = new Set(
    current.execution.items.flatMap((item) =>
      (["no_research", "research"] as const).filter((arm) => item.arms[arm].state === "pending").map((arm) => `${item.questionId}|${arm}`),
    ),
  );
  return finish(current.manifest, dataset, await driveRun(current.manifest, (q, arm) => pending.has(`${q}|${arm}`), onProgress, signal), onProgress);
}

/** Close a processing run now: arms that never finished stay missing in a partial report. */
export async function finalizeAsPartial(runId: string, dataset: LoadedDataset): Promise<RunRecord> {
  await finalizeRunRemote(runId);
  return loadStoredRun(runId, dataset);
}
