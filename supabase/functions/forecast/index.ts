/**
 * forecast POST {runId, questionId, arm, requestKey}
 *   -> {runId, itemId, attemptId, status, reasonCode, retryNotBefore, armPrediction, withheldProbability, claimDecisions, usageStatus}
 *
 * Processes exactly ONE model arm/stage for one frozen run item (PLAN.md s.4). At most one bounded
 * provider call per invocation; no multi-call chain, no sleeps, no hidden SDK retries. The browser
 * drives the loop while the page is open; closing it pauses new work.
 * Replay runs have no provider path at all: a missing recording is replay_miss.
 * Written under Dirty Mode; not deployed or invoked.
 */

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import {
  applyPostInferenceAudit,
  asOfScopeHash,
  assertNoBrowsingPayload,
  auditFlagsFor,
  buildForecastInput,
  buildMessages,
  buildProviderPayload,
  canonicalJson,
  computeRequestKey,
  CORE_VERSION,
  evaluateOutput,
  GATE_VERSION,
  gateEvidence,
  hashCanonical,
  LIMITS,
  planArm,
  PROMPT_VERSION,
  readProviderResponse,
  recomputeManifestHash,
  replayMissAttempt,
  utf8Length,
  worstCaseCallUsd,
  XAI_ENDPOINT,
  type ArmResult,
  type AttemptEvaluation,
  type AttemptRecord,
  type DatasetVersion,
  type FrozenQuestion,
  type ManifestEvidence,
  type ModelArm,
  type ModelProfile,
  type RunManifest,
} from "../_shared/engine.ts";

const LEASE_SECONDS = 90;
const FETCH_DEADLINE_MS = 50_000;

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function corsHeaders(request: Request): Record<string, string> {
  const allowed = (Deno.env.get("APP_ORIGIN") ?? "").split(",").map((o) => o.trim()).filter((o) => o !== "");
  const origin = request.headers.get("Origin") ?? "";
  const allow = allowed.length === 0 ? "*" : allowed.includes(origin) ? origin : allowed[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
  };
}

function json(request: Request, status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders(request), "Content-Type": "application/json" } });
}

/** Read a body while streaming and stop at the byte bound, whatever Content-Length says. */
async function readBounded(stream: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<Uint8Array | null> {
  if (stream == null) return new Uint8Array(0);
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** Strict UTF-8 decode; null when the bytes are not valid UTF-8. */
function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** Map an RPC/PostgREST error (MESSAGE = public code, SQLSTATE PTnnn) to an HttpError. */
function rpcError(error: { message: string; code?: string; details?: string | null }): HttpError {
  if (error.code == null || !/^PT\d{3}$/.test(error.code)) {
    console.error("forecast_db_error", error.code ?? "unknown");
    return new HttpError(500, "internal_error", "Unexpected database error.");
  }
  const code = /^[a-z_]+$/.test(error.message) ? error.message : "internal_error";
  return new HttpError(Number(error.code.slice(2)), code, error.details ?? code);
}

async function rpc<T>(client: SupabaseClient, name: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await client.rpc(name, args);
  if (error != null) throw rpcError(error);
  return data as T;
}

type RequestBody = { runId: string; questionId: string; arm: ModelArm; requestKey: string };

function parseBody(text: string): RequestBody {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new HttpError(400, "invalid_input", "Send a JSON object.");
  }
  const o = (value ?? {}) as Record<string, unknown>;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (typeof o.runId !== "string" || !uuid.test(o.runId)) throw new HttpError(400, "invalid_input", "runId must be a uuid.");
  if (typeof o.questionId !== "string" || o.questionId === "" || o.questionId.length > 200) throw new HttpError(400, "invalid_input", "questionId is required.");
  if (o.arm !== "no_research" && o.arm !== "research") throw new HttpError(400, "invalid_input", "arm must be no_research or research.");
  if (typeof o.requestKey !== "string" || !uuid.test(o.requestKey)) throw new HttpError(400, "invalid_input", "requestKey must be a uuid.");
  return { runId: o.runId, questionId: o.questionId, arm: o.arm, requestKey: o.requestKey };
}

type Loaded = {
  manifest: RunManifest;
  mode: "replay" | "live";
  versionId: string;
  version: DatasetVersion;
  question: FrozenQuestion;
  evidence: ManifestEvidence[];
};

/** Load the owned run and frozen version rows through RLS (the user's own JWT). */
async function loadFrozen(user: SupabaseClient, body: RequestBody): Promise<Loaded> {
  const { data: run, error: runError } = await user.from("runs").select("id, status, mode, dataset_version_id, manifest_hash").eq("id", body.runId).maybeSingle();
  if (runError != null) throw rpcError(runError);
  if (run == null || run.dataset_version_id == null) throw new HttpError(404, "not_found", "Run not found.");
  if (run.status !== "created" && run.status !== "processing") throw new HttpError(409, "frozen_or_mismatch", "Run is terminal; start a new linked run for unfinished work.");
  const { data: manifestRow, error: manifestError } = await user.from("run_manifests").select("manifest, manifest_hash, evaluation_keys, training_keys").eq("run_id", body.runId).single();
  if (manifestError != null) throw rpcError(manifestError);
  const manifest = manifestRow.manifest as RunManifest;
  if (manifestRow.manifest_hash !== run.manifest_hash || manifest.manifestHash !== run.manifest_hash || recomputeManifestHash(manifest) !== manifest.manifestHash) {
    throw new HttpError(409, "manifest_or_config_mismatch", "The stored run manifest does not recompute to its hash.");
  }
  const keys = manifestRow as { evaluation_keys?: string[]; training_keys?: string[] };
  // Compare as sets: SQL (COLLATE "C") and the engine (UTF-16) may order unusual IDs differently.
  const sameSet = (a: string[] | undefined, b: string[]) => canonicalJson([...(a ?? [])].sort()) === canonicalJson([...b].sort());
  if (!sameSet(keys.evaluation_keys, manifest.evaluationIds) || !sameSet(keys.training_keys, manifest.trainingIds)) {
    throw new HttpError(409, "manifest_or_config_mismatch", "Run cohort keys disagree with the manifest.");
  }
  if (manifest.coreVersion !== CORE_VERSION || manifest.promptVersion !== PROMPT_VERSION || manifest.gateVersion !== GATE_VERSION) {
    throw new HttpError(409, "manifest_or_config_mismatch", "This function's engine versions differ from the run manifest; start a new run.");
  }
  if (!manifest.evaluationIds.includes(body.questionId)) throw new HttpError(404, "not_found", "Question is not in this run.");

  const versionId = run.dataset_version_id as string;
  const [header, questions, outcome, evidence] = await Promise.all([
    user.from("dataset_versions").select("header").eq("id", versionId).single(),
    user.from("version_questions").select("row_doc").eq("dataset_version_id", versionId).order("ordinal"),
    user.from("version_outcomes").select("outcome_raw, resolution_audit_text").eq("dataset_version_id", versionId).eq("question_key", body.questionId).single(),
    user.from("version_evidence").select("row_doc").eq("dataset_version_id", versionId).eq("question_key", body.questionId).order("ordinal"),
  ]);
  for (const result of [header, questions, outcome, evidence]) if (result.error != null) throw rpcError(result.error);
  // Outcome fields are merged only for the post-inference audit; prompts read the allowlist only.
  const frozenQuestions = (questions.data ?? []).map((row) => row.row_doc as FrozenQuestion);
  const question = frozenQuestions.find((q) => q.id === body.questionId);
  if (question == null) throw new HttpError(404, "not_found", "Question not found.");
  const withAudit: FrozenQuestion = {
    ...question,
    outcome: outcome.data?.outcome_raw == null ? null : Number(outcome.data.outcome_raw),
    resolutionAuditText: (outcome.data?.resolution_audit_text as string | null) ?? "",
  };
  // A partial version (questions only) suffices for asOfScopeHash, which reads as-of fields only.
  const version = { ...(header.data?.header as DatasetVersion), questions: frozenQuestions, evidence: [], marketObservations: [], quarantine: [] } as DatasetVersion;
  return {
    manifest,
    mode: run.mode as "replay" | "live",
    versionId,
    version,
    question: withAudit,
    evidence: (evidence.data ?? []).map((row) => row.row_doc as ManifestEvidence),
  };
}

type StoredAttemptRow = { id: string; record: AttemptRecord & { requestKey: string } };

async function storedAttempts(service: SupabaseClient, body: RequestBody): Promise<StoredAttemptRow[]> {
  const { data, error } = await service
    .from("run_arm_attempts")
    .select("id, record")
    .eq("run_id", body.runId)
    .eq("question_key", body.questionId)
    .eq("arm", body.arm)
    .order("sequence");
  if (error != null) throw rpcError(error);
  return (data ?? []) as StoredAttemptRow[];
}

async function itemResult(service: SupabaseClient, body: RequestBody, attemptId: string | null, usageStatus: string) {
  const { data, error } = await service
    .from("run_items")
    .select("state, probability, withheld_probability, reason_code, retry_not_before, selected_attempt_id")
    .eq("run_id", body.runId)
    .eq("question_key", body.questionId)
    .eq("arm", body.arm)
    .single();
  if (error != null) throw rpcError(error);
  const attempts = await storedAttempts(service, body);
  const latest = attempts.find((a) => a.id === attemptId) ?? attempts[attempts.length - 1];
  const evaluation = latest?.record.evaluation;
  return {
    runId: body.runId,
    itemId: `${body.questionId}:${body.arm}`,
    attemptId: latest?.id ?? null,
    status: data.state,
    reasonCode: data.reason_code,
    retryNotBefore: data.retry_not_before,
    armPrediction: data.probability == null ? null : Number(data.probability),
    withheldProbability: data.withheld_probability == null ? null : Number(data.withheld_probability),
    claimDecisions: evaluation != null && evaluation.status !== "failed" ? evaluation.claims : [],
    usageStatus,
  };
}

/** Next run_items state after the newest attempt, from the same pure planner the browser uses. */
function nextState(body: RequestBody, evidenceCount: number, attempts: AttemptRecord[]): { state: ArmResult["state"]; selected: string | null } {
  const step = planArm(body.questionId, body.arm, evidenceCount, attempts);
  if (step.action === "call") return { state: "pending", selected: null };
  const result = applyPostInferenceAudit(step.result);
  return { state: result.state, selected: result.selectedAttemptId };
}

function providerUsd(profile: ModelProfile, usage: { promptTokens: number | null; completionTokens: number | null }): number | null {
  const pricing = profile.pricing;
  if (pricing == null || usage.promptTokens == null || usage.completionTokens == null) return null;
  const usd = (usage.promptTokens * pricing.inputUsdPerMTok + usage.completionTokens * pricing.outputUsdPerMTok) / 1_000_000;
  // Reported actual usage is informational; out-of-range values are dropped rather than failing settlement.
  return Number.isFinite(usd) && usd >= 0 && usd <= 1000 ? usd : null;
}

function retryAfterSeconds(response: Response): number {
  const raw = Number(response.headers.get("Retry-After"));
  return Number.isFinite(raw) && raw > 0 ? Math.min(300, Math.max(1, Math.round(raw))) : 5;
}

type LiveOutcome = { evaluation: AttemptEvaluation; rawText: string | null; retryNotBefore: string | null; usageStatus: string };

/** One bounded provider call. The reservation is never released for a possibly billed attempt. */
async function callProvider(service: SupabaseClient, providerAttemptId: string, profile: ModelProfile, apiKey: string, payloadText: string): Promise<LiveOutcome> {
  const settle = (status: string, actual: number | null, usage: unknown, requestId: string | null, code: string | null, retryAt: string | null) =>
    rpc<void>(service, "finalize_attempt", {
      p_attempt_id: providerAttemptId,
      p_status: status,
      p_actual_usd: actual,
      p_usage: usage,
      p_provider_request_id: requestId,
      p_error_code: code,
      p_retry_not_before: retryAt,
    });
  let response: Response;
  try {
    response = await fetch(XAI_ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: payloadText,
      signal: AbortSignal.timeout(FETCH_DEADLINE_MS),
      redirect: "error",
    });
  } catch {
    // The request may have reached the provider: keep the charge (unknown), allow the remaining slot later.
    const retryAt = new Date(Date.now() + 5_000).toISOString();
    await settle("unknown", null, null, null, "network_or_timeout", null);
    return { evaluation: { status: "failed", code: "provider_transient", detail: "Network error or 50 s deadline; charge kept as unknown." }, rawText: null, retryNotBefore: retryAt, usageStatus: "unknown_charge_reserved" };
  }
  const headerId = response.headers.get("x-request-id");
  const requestId = headerId != null && headerId.length <= 256 && /^[\x20-\x7e]+$/.test(headerId) ? headerId : null;
  if (response.status === 429 || response.status >= 500) {
    await response.body?.cancel();
    const retryAt = new Date(Date.now() + retryAfterSeconds(response) * 1000).toISOString();
    await settle("failed_transient", null, null, requestId, `http_${response.status}`, retryAt);
    return { evaluation: { status: "failed", code: "provider_transient", detail: `Provider HTTP ${response.status}.` }, rawText: null, retryNotBefore: retryAt, usageStatus: "reserved_charge_kept" };
  }
  if (!response.ok) {
    await response.body?.cancel();
    await settle("failed_terminal", null, null, requestId, `http_${response.status}`, null);
    return { evaluation: { status: "failed", code: "provider_terminal", detail: `Provider HTTP ${response.status} (auth/request/policy); no automatic retry.` }, rawText: null, retryNotBefore: null, usageStatus: "reserved_charge_kept" };
  }
  let bytes: Uint8Array | null;
  try {
    bytes = await readBounded(response.body, LIMITS.providerResponseBytes);
  } catch {
    // Deadline or network failure while streaming: transient, charge kept as unknown.
    const retryAt = new Date(Date.now() + 5_000).toISOString();
    await settle("unknown", null, null, requestId, "body_read_failed", null);
    return { evaluation: { status: "failed", code: "provider_transient", detail: "The response could not be read completely; charge kept as unknown." }, rawText: null, retryNotBefore: retryAt, usageStatus: "unknown_charge_reserved" };
  }
  // Too large or not UTF-8: a terminal response problem (no automatic retry).
  const text = bytes == null ? null : decodeUtf8(bytes);
  if (text == null) {
    await settle("failed_terminal", null, null, requestId, "response_too_large_or_invalid_utf8", null);
    return { evaluation: { status: "failed", code: "provider_terminal", detail: "Response exceeded 64 KiB or was not UTF-8." }, rawText: null, retryNotBefore: null, usageStatus: "reserved_charge_kept" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  const reading = readProviderResponse(parsed);
  if (!reading.ok) {
    await settle("failed_terminal", null, null, requestId, reading.code, null);
    return { evaluation: { status: "failed", code: "provider_terminal", detail: `Rejected response: ${reading.code}.` }, rawText: null, retryNotBefore: null, usageStatus: "reserved_charge_kept" };
  }
  const usage = { promptTokens: reading.usage.promptTokens, completionTokens: reading.usage.completionTokens };
  await settle("succeeded", providerUsd(profile, usage), usage, reading.providerRequestId ?? requestId, null, null);
  return { evaluation: { status: "failed", code: "pending_evaluation", detail: "" }, rawText: reading.content, retryNotBefore: null, usageStatus: "settled" };
}

async function handle(request: Request): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(request) });
  if (request.method !== "POST") throw new HttpError(405, "invalid_input", "Use POST.");
  const authHeader = request.headers.get("Authorization");
  if (authHeader == null || !authHeader.startsWith("Bearer ")) throw new HttpError(401, "invalid_session", "Sign in first.");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !anonKey || !serviceKey) throw new HttpError(503, "configuration_required", "Platform settings are missing.");

  const raw = await readBounded(request.body, LIMITS.forecastRequestBytes);
  if (raw == null) throw new HttpError(400, "invalid_input", "Request body exceeds 16 KiB.");
  const text = decodeUtf8(raw);
  if (text == null) throw new HttpError(400, "invalid_input", "Request body is not valid UTF-8.");
  const body = parseBody(text);

  const user = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } }, auth: { persistSession: false, autoRefreshToken: false } });
  const { data: userData, error: userError } = await user.auth.getUser();
  if (userError != null || userData.user == null) throw new HttpError(401, "invalid_session", "The session is not valid.");
  const ownerId = userData.user.id;
  // Privileged RPCs run only after JWT and ownership checks; each RPC re-validates its own invariants.
  const service = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

  const loaded = await loadFrozen(user, body);

  // A completed request key returns its stored output; no extra call.
  const duplicate = (await storedAttempts(service, body)).find((a) => a.record.requestKey === body.requestKey);
  if (duplicate != null) return json(request, 200, await itemResult(service, body, duplicate.id, "cached_result"));

  const gate = gateEvidence(
    { id: loaded.question.id, cutoffAt: loaded.question.cutoffAt ?? "", evidenceCutoff: loaded.question.evidenceCutoff ?? "" },
    loaded.evidence,
    loaded.version.protocol,
    LIMITS.excerptCodePoints,
  );
  await rpc<void>(service, "record_prompt_evidence", {
    p_run_id: body.runId,
    p_question_key: body.questionId,
    p_prompt_evidence: gate.promptEvidence,
    p_prompt_evidence_hash: gate.promptEvidenceHash,
    p_ledger: gate.ledger,
    p_funnel: gate.funnel,
  });

  const lease = await rpc<{ leased: boolean; state: string; retryNotBefore?: string }>(service, "lease_arm", {
    p_user_id: ownerId,
    p_run_id: body.runId,
    p_question_key: body.questionId,
    p_arm: body.arm,
    p_holder: body.requestKey,
    p_lease_seconds: LEASE_SECONDS,
  });
  if (!lease.leased) return json(request, 200, await itemResult(service, body, null, lease.state === "pending" ? "retry_not_before" : "no_call"));

  const finalize = (attempt: Record<string, unknown> | null, state: string, selected: string | null, retryAt: string | null) =>
    rpc<string | null>(service, "finalize_arm_result", {
      p_run_id: body.runId,
      p_question_key: body.questionId,
      p_arm: body.arm,
      p_holder: body.requestKey,
      p_attempt: attempt,
      p_claim_decisions: attempt != null && (attempt.evaluation as AttemptEvaluation).status !== "failed" ? (attempt.evaluation as { claims: unknown[] }).claims : [],
      p_next_state: state,
      p_selected_attempt_id: selected,
      p_retry_not_before: retryAt,
    });

  try {
    const prior = (await storedAttempts(service, body)).map((row) => row.record as AttemptRecord);
    const step = planArm(body.questionId, body.arm, gate.promptEvidence.length, prior);
    return await afterLease(request, service, body, ownerId, loaded, gate, prior, step, finalize);
  } catch (error) {
    // Release the lease on any refusal after leasing (config, budget, payload) so the run is not
    // blocked for 90 s. Best effort: pending is refused when no slot remains, which is fine.
    await finalize(null, "pending", null, null).catch(() => undefined);
    throw error;
  }
}

async function afterLease(
  request: Request,
  service: SupabaseClient,
  body: RequestBody,
  ownerId: string,
  loaded: Loaded,
  gate: ReturnType<typeof gateEvidence>,
  prior: AttemptRecord[],
  step: ReturnType<typeof planArm>,
  finalize: (attempt: Record<string, unknown> | null, state: string, selected: string | null, retryAt: string | null) => Promise<string | null>,
): Promise<Response> {
  if (step.action === "stop") {
    const result = applyPostInferenceAudit(step.result);
    await finalize(null, result.state, result.selectedAttemptId, null);
    return json(request, 200, await itemResult(service, body, null, "no_call"));
  }

  if (loaded.question.cutoffAt == null) throw new HttpError(409, "frozen_or_mismatch", "Question has no eligible cutoff.");
  const input = buildForecastInput({ ...loaded.question, cutoffAt: loaded.question.cutoffAt }, gate.promptEvidence, body.arm);
  const messages = buildMessages(input, step.feedback);
  const base = {
    attemptId: crypto.randomUUID(),
    questionId: body.questionId,
    arm: body.arm,
    sequence: step.sequence,
    kind: step.kind,
    requestHash: hashCanonical(messages),
    promptEvidenceHash: gate.promptEvidenceHash,
    requestKey: body.requestKey,
  };
  const fullLength = (id: string) => loaded.evidence.find((e) => e.id === id)?.excerpt.length ?? null;
  const record = (fields: Pick<AttemptRecord, "origin" | "model"> & Partial<AttemptRecord> & Record<string, unknown>, evaluation: AttemptEvaluation, rawText: string | null): AttemptRecord & Record<string, unknown> => ({
    ...base,
    ...fields,
    evaluation,
    rawText,
    auditFlags: auditFlagsFor(body.arm, evaluation, loaded.question),
  });

  if (loaded.mode === "live") {
    // A slot whose lease expired after its charge was reserved has a provider_attempts row but no
    // attempt row. Record it as a failed transient attempt with its (kept) charge, so the engine
    // planner and the database agree on the sequence and the two-call ceiling.
    const { data: lost, error: lostError } = await service
      .from("provider_attempts")
      .select("id, sequence, status, retry_not_before")
      .eq("run_id", body.runId)
      .eq("question_key", body.questionId)
      .eq("arm", body.arm)
      .eq("sequence", step.sequence)
      .neq("status", "not_sent")
      .maybeSingle();
    if (lostError != null) throw rpcError(lostError);
    if (lost != null && lost.status !== "reserved" && loaded.manifest.modelProfile != null) {
      // A slot already settled as a terminal provider error stays terminal (no automatic retry).
      const evaluation: AttemptEvaluation =
        lost.status === "failed_terminal"
          ? { status: "failed", code: "provider_terminal", detail: "lost_slot_terminal: the earlier request ended with a terminal provider error; its charge stays consumed." }
          : { status: "failed", code: "provider_transient", detail: "lease_expired_unknown_charge: the earlier request did not finish; its charge stays consumed." };
      const cacheKey = computeRequestKey({
        ownerId,
        datasetScope: asOfScopeHash(loaded.version),
        profile: loaded.manifest.modelProfile,
        input,
        promptEvidenceHash: gate.promptEvidenceHash,
        feedback: step.feedback,
      });
      const attempt = record({ attemptId: lost.id, origin: "live", model: null, cacheKey, providerAttemptId: lost.id }, evaluation, null);
      const next = nextState(body, gate.promptEvidence.length, [...prior, attempt as AttemptRecord]);
      const attemptId = await finalize(attempt, next.state, next.selected, next.state === "pending" ? ((lost.retry_not_before as string | null) ?? null) : null);
      return json(request, 200, await itemResult(service, body, attemptId, "lost_slot_recorded_charge_kept"));
    }
  }

  if (loaded.mode === "replay") {
    const { data: recording, error } = await service
      .from("version_recordings")
      .select("origin, output, model")
      .eq("dataset_version_id", loaded.versionId)
      .eq("question_key", body.questionId)
      .eq("arm", body.arm)
      .eq("sequence", step.sequence)
      .maybeSingle();
    if (error != null) throw rpcError(error);
    if (recording == null) {
      // Same terminal state the engine derives with its replay-miss attempt (failed/replay_miss, or
      // withheld when an earlier withheld attempt exists). No attempt row is stored for the miss.
      const miss = replayMissAttempt(body.runId, body.questionId, body.arm, step.sequence, step.kind, base.requestHash, gate.promptEvidenceHash);
      const next = nextState(body, gate.promptEvidence.length, [...prior, miss]);
      await finalize(null, next.state, next.selected, null);
      return json(request, 200, await itemResult(service, body, null, "replay_miss_no_call"));
    }
    const output = recording.output as { kind: "text"; text: string } | { kind: "failure"; code: string };
    const evaluation: AttemptEvaluation =
      output.kind === "text"
        ? evaluateOutput(output.text, body.arm, gate.promptEvidence, gate.ledger, fullLength)
        : { status: "failed", code: output.code, detail: "Recorded failure." };
    const attempt = record({ origin: recording.origin, model: recording.model ?? null }, evaluation, output.kind === "text" ? output.text : null);
    const next = nextState(body, gate.promptEvidence.length, [...prior, attempt as AttemptRecord]);
    const attemptId = await finalize(attempt, next.state, next.selected, null);
    return json(request, 200, await itemResult(service, body, attemptId, "replay_no_provider"));
  }

  // Live: configuration checks happen before any reservation or provider contact.
  const apiKey = Deno.env.get("XAI_API_KEY");
  const modelId = Deno.env.get("FORECAST_MODEL_ID");
  const profile = loaded.manifest.modelProfile;
  if (!apiKey || !modelId || profile == null || profile.modelId !== modelId || profile.endpoint !== XAI_ENDPOINT) {
    throw new HttpError(503, "configuration_required", "Live forecasting needs XAI_API_KEY, FORECAST_MODEL_ID matching the pinned profile, and an enabled profile.");
  }
  const { data: currentProfile, error: profileError } = await service.from("model_profiles").select("enabled, profile").eq("profile_version", profile.profileVersion).maybeSingle();
  if (profileError != null) throw rpcError(profileError);
  if (currentProfile == null || !currentProfile.enabled) throw new HttpError(503, "configuration_required", "The pinned model profile is not enabled.");
  if (canonicalJson(currentProfile.profile) !== canonicalJson(profile)) throw new HttpError(409, "manifest_or_config_mismatch", "Model profile changed since the run was frozen; start a new run.");

  const payload = buildProviderPayload(profile, messages);
  const violation = assertNoBrowsingPayload(payload as unknown as Record<string, unknown>, [modelId]);
  if (violation != null) throw new HttpError(503, "configuration_required", `No-browsing guard: ${violation}.`);
  const payloadText = JSON.stringify(payload);
  const payloadBytes = utf8Length(payloadText);
  if (payloadBytes > LIMITS.providerRequestBytes) throw new HttpError(400, "invalid_input", "Serialized provider request exceeds 128 KiB.");
  const worstCase = worstCaseCallUsd(profile, payloadBytes);
  if (worstCase == null) throw new HttpError(503, "configuration_required", "Unverified pricing, tokenization or reasoning billing blocks charged calls.");

  const cacheKey = computeRequestKey({
    ownerId,
    datasetScope: asOfScopeHash(loaded.version),
    profile,
    input,
    promptEvidenceHash: gate.promptEvidenceHash,
    feedback: step.feedback,
  });
  const { data: cached, error: cacheError } = await service
    .from("run_arm_attempts")
    .select("id, raw_text")
    .eq("user_id", ownerId)
    .eq("dataset_version_id", loaded.versionId)
    .eq("cache_key", cacheKey)
    .eq("origin", "live")
    .not("raw_text", "is", null)
    .order("created_at")
    .limit(1)
    .maybeSingle();
  if (cacheError != null) throw rpcError(cacheError);
  if (cached != null) {
    // Labelled cache hit: not a new independent live observation and not a new charge.
    const evaluation = evaluateOutput(cached.raw_text as string, body.arm, gate.promptEvidence, gate.ledger, fullLength);
    const attempt = record({ origin: "cache_hit", model: { provider: profile.provider, modelId: profile.modelId, note: "cache hit" }, cacheKey, cacheSourceAttemptId: cached.id }, evaluation, cached.raw_text as string);
    const next = nextState(body, gate.promptEvidence.length, [...prior, attempt as AttemptRecord]);
    const attemptId = await finalize(attempt, next.state, next.selected, null);
    return json(request, 200, await itemResult(service, body, attemptId, "cache_hit_no_charge"));
  }

  const providerAttemptId = await rpc<string>(service, "reserve_attempt", {
    p_user_id: ownerId,
    p_run_id: body.runId,
    p_question_key: body.questionId,
    p_arm: body.arm,
    p_sequence: step.sequence,
    p_request_key: body.requestKey,
    p_worst_case_usd: worstCase,
    p_lease_holder: body.requestKey,
  });
  const outcome = await callProvider(service, providerAttemptId, profile, apiKey, payloadText);
  const evaluation = outcome.rawText != null ? evaluateOutput(outcome.rawText, body.arm, gate.promptEvidence, gate.ledger, fullLength) : outcome.evaluation;
  const attempt = record({ origin: "live", model: { provider: profile.provider, modelId: profile.modelId, note: profile.profileVersion }, cacheKey, providerAttemptId }, evaluation, outcome.rawText);
  const next = nextState(body, gate.promptEvidence.length, [...prior, attempt as AttemptRecord]);
  const attemptId = await finalize(attempt, next.state, next.selected, next.state === "pending" ? outcome.retryNotBefore : null);
  return json(request, 200, await itemResult(service, body, attemptId, outcome.usageStatus));
}

Deno.serve(async (request: Request) => {
  try {
    return await handle(request);
  } catch (error) {
    if (error instanceof HttpError) return json(request, error.status, { error: error.code, message: error.message });
    // Sanitized: no provider bodies, headers or secrets in responses or logs.
    console.error("forecast_internal_error", error instanceof Error ? error.name : "unknown");
    return json(request, 500, { error: "internal_error", message: "Unexpected server error." });
  }
});
