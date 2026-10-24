/**
 * Manifest v1 import, validation, cutoff presets and the frozen DatasetVersion (PLAN.md s.2).
 *
 * Structural problems (bad schema, malformed timestamps, duplicate IDs, unresolved references,
 * envelope overflow, forged origins, hash mismatches) fail the whole import. Temporal, wording and
 * outcome problems on otherwise well-formed rows produce explicit quarantine rows instead.
 */

import { hashCanonical, sha256Hex, utf8Length } from "./canonical.ts";
import { DAY_MS, floorUtcToHour, HOUR_MS, isoUtc, parseUtc, parseUtcDate, type PublishedTime } from "./time.ts";

export const SCHEMA_VERSION = 1;
export const CORE_VERSION = "s14-core-1";
export const GATE_VERSION = "gate-1";
export const PROMPT_VERSION = "prompt-1";
export const BLOCKLIST_VERSION = "blocklist-1";
export const FALLBACK_POLICY = "research_else_noResearch_else_half";

export const LIMITS = {
  importBytes: 1_048_576,
  totalQuestions: 100,
  evidencePerQuestion: 50,
  observationsPerQuestion: 50,
  promptExcerptsPerQuestion: 8,
  excerptCodePoints: 2000,
  claimsMax: 16,
  rationaleChars: 2000,
  outputTokenMax: 1024,
  forecastRequestBytes: 16_384,
  providerRequestBytes: 131_072,
  providerResponseBytes: 65_536,
  attemptsPerArm: 2,
  demoEvaluationItems: 6,
} as const;

export type DatasetKind = "synthetic" | "real";
export type CutoffPreset = "supplied-fixed-v1" | "scheduled-midpoint-v1";
export type QuestionRole = "training" | "evaluation";
export type ModelArm = "no_research" | "research";
export type ImportedOrigin = "demo" | "recorded" | "manual";

export type ProtocolCard = {
  protocolId: string;
  cutoffPreset: CutoffPreset;
  cutoffSelectionNote: string;
  fallbackPolicy: typeof FALLBACK_POLICY;
  sourceBufferHours: number;
  maxPriceAgeHours: number;
  trainMinimum: number;
  calibrationBins: 5 | 10;
  maxPromptExcerpts: number;
  eligibilityNote: string;
  modelProfileVersion: string;
  promptVersion: string;
  gateVersion: string;
  blocklistVersion: string;
  bootstrapSeed: number;
  bootstrapReplicates: number;
};

export type ManifestQuestion = {
  id: string;
  role: QuestionRole;
  category: string;
  eventClusterId: string;
  questionTextAsOf: string;
  resolutionRulesAsOf: string;
  opensAt: string;
  wordingAvailableAt: string;
  wordingVersionProof: string;
  suppliedCutoffAt: string | null;
  scheduledCloseAt: string | null;
  scheduledCloseProvenance: string | null;
  actualCloseAt: string | null;
  resolvedAt: string;
  /** Raw imported outcome. Only exactly 0 or 1 is eligible. Scoring-only; never enters ForecastInput. */
  outcome: number | null;
  /** Offline audit text (resolution sentence). Never enters ForecastInput or request hashes. */
  resolutionAuditText: string;
};

export type QuestionStatus = "eligible" | "quarantined";

export type FrozenQuestion = ManifestQuestion & {
  cutoffAt: string | null;
  evidenceCutoff: string | null;
  cutoffProvenance: string;
  status: QuestionStatus;
  quarantineReasons: string[];
};

export type ManifestEvidence = {
  id: string;
  questionId: string;
  title: string;
  /** Inert provenance URL. Never fetched. */
  url: string;
  published: PublishedTime;
  retrievedAt: string;
  versionAvailableAt: string | null;
  versionProof: string | null;
  /** Latest known edit/update time of the captured version, when the capture shows one. */
  updatedAt: string | null;
  excerpt: string;
  rightsNote: string;
  /** SHA-256 of the full excerpt, always recomputed on import. */
  contentHash: string;
};

export type MarketObservation = {
  id: string;
  questionId: string;
  yesProbability: number;
  observedAt: string;
  venue: string;
  provenance: string;
};

export type RecordedOutput = { kind: "text"; text: string } | { kind: "failure"; code: string };

export type ModelMeta = { provider: string; modelId: string; note: string };

export type RecordedAttempt = {
  id: string;
  questionId: string;
  arm: ModelArm;
  origin: ImportedOrigin;
  sequence: 1 | 2;
  output: RecordedOutput;
  model: ModelMeta | null;
};

export type Manifest = {
  schemaVersion: 1;
  datasetId: string;
  name: string;
  kind: DatasetKind;
  provenance: string;
  rights: string;
  protocol: ProtocolCard;
  questions: ManifestQuestion[];
  evidence: ManifestEvidence[];
  marketObservations: MarketObservation[];
  recordedAttempts: RecordedAttempt[];
};

export type QuarantineRow = {
  targetType: "question" | "evidence" | "observation";
  targetId: string;
  questionId: string;
  reason: string;
  detail: string;
};

export type DatasetVersion = {
  schemaVersion: 1;
  coreVersion: string;
  datasetId: string;
  name: string;
  kind: DatasetKind;
  provenance: string;
  rights: string;
  protocol: ProtocolCard;
  protocolHash: string;
  questions: FrozenQuestion[];
  evidence: ManifestEvidence[];
  marketObservations: MarketObservation[];
  quarantine: QuarantineRow[];
  frozenAt: string;
  versionHash: string;
};

export type ImportIssue = { path: string; code: string; message: string };

export type ImportResult =
  | {
      ok: true;
      version: DatasetVersion;
      recordings: RecordedAttempt[];
      recordingsHash: string;
      warnings: ImportIssue[];
    }
  | { ok: false; errors: ImportIssue[] };

// ---------------------------------------------------------------------------------------------
// Field readers. Each pushes an issue and returns a fallback value so validation reports every
// structural problem in one pass.

type Obj = Record<string, unknown>;

class Reader {
  readonly issues: ImportIssue[] = [];

  fail(path: string, code: string, message: string): void {
    this.issues.push({ path, code, message });
  }

  obj(value: unknown, path: string): Obj {
    if (value == null || typeof value !== "object" || Array.isArray(value)) {
      this.fail(path, "invalid_input", "Expected an object.");
      return {};
    }
    return value as Obj;
  }

  arr(value: unknown, path: string): unknown[] {
    if (!Array.isArray(value)) {
      this.fail(path, "invalid_input", "Expected an array.");
      return [];
    }
    return value;
  }

  str(o: Obj, key: string, path: string, nonEmpty = true): string {
    const value = o[key];
    if (typeof value !== "string" || (nonEmpty && value.trim() === "")) {
      this.fail(`${path}.${key}`, "invalid_input", nonEmpty ? "Expected a non-empty string." : "Expected a string.");
      return "";
    }
    return value;
  }

  optStr(o: Obj, key: string, path: string): string | null {
    const value = o[key];
    if (value == null) return null;
    if (typeof value !== "string") {
      this.fail(`${path}.${key}`, "invalid_input", "Expected a string or null.");
      return null;
    }
    return value;
  }

  utc(o: Obj, key: string, path: string): string {
    const value = o[key];
    if (parseUtc(value) == null) {
      this.fail(`${path}.${key}`, "invalid_timestamp", "Expected an explicit-UTC ISO timestamp (Z or +00:00).");
      return "";
    }
    return value as string;
  }

  optUtc(o: Obj, key: string, path: string): string | null {
    const value = o[key];
    if (value == null) return null;
    if (parseUtc(value) == null) {
      this.fail(`${path}.${key}`, "invalid_timestamp", "Expected an explicit-UTC ISO timestamp or null.");
      return null;
    }
    return value as string;
  }

  num(o: Obj, key: string, path: string): number {
    const value = o[key];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      this.fail(`${path}.${key}`, "invalid_input", "Expected a finite number.");
      return Number.NaN;
    }
    return value;
  }
}

function readPublished(r: Reader, value: unknown, path: string): PublishedTime {
  const o = r.obj(value, path);
  switch (o.precision) {
    case "instant":
      return { precision: "instant", at: r.utc(o, "at", path) };
    case "day": {
      if (parseUtcDate(o.date) == null) r.fail(`${path}.date`, "invalid_timestamp", "Expected YYYY-MM-DD.");
      return { precision: "day", date: typeof o.date === "string" ? o.date : "" };
    }
    case "interval":
      return { precision: "interval", start: r.utc(o, "start", path), end: r.utc(o, "end", path) };
    case "unknown":
      return { precision: "unknown" };
    default:
      r.fail(`${path}.precision`, "invalid_input", "precision must be instant, day, interval or unknown.");
      return { precision: "unknown" };
  }
}

function readProtocol(r: Reader, value: unknown, kind: DatasetKind): ProtocolCard {
  const path = "$.protocol";
  const o = r.obj(value, path);
  const preset = o.cutoffPreset;
  if (preset !== "supplied-fixed-v1" && preset !== "scheduled-midpoint-v1") {
    r.fail(`${path}.cutoffPreset`, "invalid_input", "cutoffPreset must be supplied-fixed-v1 or scheduled-midpoint-v1.");
  }
  if (o.fallbackPolicy !== FALLBACK_POLICY) {
    r.fail(`${path}.fallbackPolicy`, "invalid_input", `fallbackPolicy must be ${FALLBACK_POLICY}.`);
  }
  const buffer = r.num(o, "sourceBufferHours", path);
  const requiredBuffer = kind === "synthetic" ? 0 : 24;
  if (buffer !== requiredBuffer) {
    r.fail(`${path}.sourceBufferHours`, "protocol_mismatch", `A ${kind} dataset uses a ${requiredBuffer}h source buffer.`);
  }
  const priceAge = r.num(o, "maxPriceAgeHours", path);
  if (priceAge !== 24) r.fail(`${path}.maxPriceAgeHours`, "protocol_mismatch", "maxPriceAgeHours is fixed at 24.");
  const trainMinimum = r.num(o, "trainMinimum", path);
  if (!Number.isInteger(trainMinimum) || trainMinimum < 10) {
    r.fail(`${path}.trainMinimum`, "protocol_mismatch", "trainMinimum must be an integer of at least 10.");
  }
  const bins = r.num(o, "calibrationBins", path);
  if (bins !== 5 && bins !== 10) r.fail(`${path}.calibrationBins`, "protocol_mismatch", "calibrationBins must be 5 or 10.");
  const maxExcerpts = r.num(o, "maxPromptExcerpts", path);
  if (!Number.isInteger(maxExcerpts) || maxExcerpts < 1 || maxExcerpts > LIMITS.promptExcerptsPerQuestion) {
    r.fail(`${path}.maxPromptExcerpts`, "protocol_mismatch", `maxPromptExcerpts must be 1..${LIMITS.promptExcerptsPerQuestion}.`);
  }
  const promptVersion = r.str(o, "promptVersion", path);
  if (promptVersion !== "" && promptVersion !== PROMPT_VERSION) {
    r.fail(`${path}.promptVersion`, "protocol_version_unsupported", `This build implements ${PROMPT_VERSION}.`);
  }
  const gateVersion = r.str(o, "gateVersion", path);
  if (gateVersion !== "" && gateVersion !== GATE_VERSION) {
    r.fail(`${path}.gateVersion`, "protocol_version_unsupported", `This build implements ${GATE_VERSION}.`);
  }
  const blocklistVersion = r.str(o, "blocklistVersion", path);
  if (blocklistVersion !== "" && blocklistVersion !== BLOCKLIST_VERSION) {
    r.fail(`${path}.blocklistVersion`, "protocol_version_unsupported", `This build implements ${BLOCKLIST_VERSION}.`);
  }
  const seed = r.num(o, "bootstrapSeed", path);
  if (!Number.isInteger(seed) || seed < 1 || seed > 0xffffffff) {
    r.fail(`${path}.bootstrapSeed`, "invalid_input", "bootstrapSeed must be a nonzero uint32.");
  }
  const replicates = r.num(o, "bootstrapReplicates", path);
  if (replicates !== 2000) r.fail(`${path}.bootstrapReplicates`, "protocol_mismatch", "bootstrapReplicates is fixed at 2000.");
  return {
    protocolId: r.str(o, "protocolId", path),
    cutoffPreset: preset === "scheduled-midpoint-v1" ? "scheduled-midpoint-v1" : "supplied-fixed-v1",
    cutoffSelectionNote: r.str(o, "cutoffSelectionNote", path),
    fallbackPolicy: FALLBACK_POLICY,
    sourceBufferHours: buffer,
    maxPriceAgeHours: priceAge,
    trainMinimum,
    calibrationBins: bins === 10 ? 10 : 5,
    maxPromptExcerpts: maxExcerpts,
    eligibilityNote: r.str(o, "eligibilityNote", path),
    modelProfileVersion: r.str(o, "modelProfileVersion", path),
    promptVersion,
    gateVersion,
    blocklistVersion,
    bootstrapSeed: seed,
    bootstrapReplicates: replicates,
  };
}

function readQuestion(r: Reader, value: unknown, path: string): ManifestQuestion {
  const o = r.obj(value, path);
  const role = o.role;
  if (role !== "training" && role !== "evaluation") r.fail(`${path}.role`, "invalid_input", "role must be training or evaluation.");
  const outcome = o.outcome;
  return {
    id: r.str(o, "id", path),
    role: role === "training" ? "training" : "evaluation",
    category: r.str(o, "category", path),
    eventClusterId: r.str(o, "eventClusterId", path),
    questionTextAsOf: r.str(o, "questionTextAsOf", path),
    resolutionRulesAsOf: r.str(o, "resolutionRulesAsOf", path),
    opensAt: r.utc(o, "opensAt", path),
    wordingAvailableAt: r.utc(o, "wordingAvailableAt", path),
    wordingVersionProof: r.str(o, "wordingVersionProof", path, false),
    suppliedCutoffAt: r.optUtc(o, "cutoffAt", path),
    scheduledCloseAt: r.optUtc(o, "scheduledCloseAt", path),
    scheduledCloseProvenance: r.optStr(o, "scheduledCloseProvenance", path),
    actualCloseAt: r.optUtc(o, "actualCloseAt", path),
    resolvedAt: r.utc(o, "resolvedAt", path),
    // Kept raw: void/fractional/ambiguous outcomes are quarantined, not rejected structurally.
    outcome: typeof outcome === "number" && Number.isFinite(outcome) ? outcome : null,
    resolutionAuditText: r.str(o, "resolutionAuditText", path, false),
  };
}

function readEvidence(r: Reader, value: unknown, path: string): ManifestEvidence {
  const o = r.obj(value, path);
  const excerpt = r.str(o, "excerpt", path);
  const computed = sha256Hex(excerpt);
  const supplied = r.optStr(o, "contentHash", path);
  if (supplied != null && supplied.toLowerCase() !== computed) {
    r.fail(`${path}.contentHash`, "hash_mismatch", "contentHash does not match the SHA-256 of the excerpt.");
  }
  return {
    id: r.str(o, "id", path),
    questionId: r.str(o, "questionId", path),
    title: r.str(o, "title", path),
    url: r.str(o, "url", path, false),
    published: readPublished(r, o.published, `${path}.published`),
    retrievedAt: r.utc(o, "retrievedAt", path),
    versionAvailableAt: r.optUtc(o, "versionAvailableAt", path),
    versionProof: r.optStr(o, "versionProof", path),
    updatedAt: r.optUtc(o, "updatedAt", path),
    excerpt,
    rightsNote: r.str(o, "rightsNote", path, false),
    contentHash: computed,
  };
}

function readObservation(r: Reader, value: unknown, path: string): MarketObservation {
  const o = r.obj(value, path);
  const p = r.num(o, "yesProbability", path);
  if (Number.isFinite(p) && (p < 0 || p > 1)) r.fail(`${path}.yesProbability`, "invalid_input", "yesProbability must be in [0, 1].");
  return {
    id: r.str(o, "id", path),
    questionId: r.str(o, "questionId", path),
    yesProbability: p,
    observedAt: r.utc(o, "observedAt", path),
    venue: r.str(o, "venue", path),
    provenance: r.str(o, "provenance", path),
  };
}

function readAttempt(r: Reader, value: unknown, path: string): RecordedAttempt {
  const o = r.obj(value, path);
  const arm = o.arm;
  if (arm !== "no_research" && arm !== "research") r.fail(`${path}.arm`, "invalid_input", "arm must be no_research or research.");
  const origin = o.origin;
  if (origin === "live" || origin === "cache_hit") {
    r.fail(`${path}.origin`, "forged_origin", "Imports cannot assert live or cache-hit origin.");
  } else if (origin !== "demo" && origin !== "recorded" && origin !== "manual") {
    r.fail(`${path}.origin`, "invalid_input", "origin must be demo, recorded or manual.");
  }
  const sequence = o.sequence;
  if (sequence !== 1 && sequence !== 2) r.fail(`${path}.sequence`, "invalid_input", "sequence must be 1 or 2.");
  const out = r.obj(o.output, `${path}.output`);
  let output: RecordedOutput = { kind: "failure", code: "invalid_recording" };
  if (out.kind === "text") output = { kind: "text", text: r.str(out, "text", `${path}.output`, false) };
  else if (out.kind === "failure") output = { kind: "failure", code: r.str(out, "code", `${path}.output`) };
  else r.fail(`${path}.output.kind`, "invalid_input", "output.kind must be text or failure.");
  let model: ModelMeta | null = null;
  if (o.model != null) {
    const m = r.obj(o.model, `${path}.model`);
    model = {
      provider: r.str(m, "provider", `${path}.model`),
      modelId: r.str(m, "modelId", `${path}.model`),
      note: r.str(m, "note", `${path}.model`, false),
    };
  }
  return {
    id: r.str(o, "id", path),
    questionId: r.str(o, "questionId", path),
    arm: arm === "research" ? "research" : "no_research",
    origin: origin === "recorded" || origin === "manual" ? origin : "demo",
    sequence: sequence === 2 ? 2 : 1,
    output,
    model,
  };
}

// ---------------------------------------------------------------------------------------------
// Cutoff presets.

export type CutoffDecision =
  | { ok: true; cutoffAt: string; provenance: string }
  | { ok: false; reason: string; detail: string };

/** scheduled-midpoint-v1: t0 = floorUTCToHour(min(opensAt + 0.5*(scheduledClose - opensAt), scheduledClose - 3 days)). */
export function scheduledMidpointCutoff(question: ManifestQuestion): CutoffDecision {
  const opens = parseUtc(question.opensAt);
  const scheduled = parseUtc(question.scheduledCloseAt);
  const resolved = parseUtc(question.resolvedAt);
  if (opens == null || resolved == null) return { ok: false, reason: "temporal_order", detail: "Missing opensAt or resolvedAt." };
  if (scheduled == null || question.scheduledCloseProvenance == null || question.scheduledCloseProvenance.trim() === "") {
    return { ok: false, reason: "midpoint_missing_schedule", detail: "scheduled-midpoint-v1 needs a historical scheduledCloseAt with provenance." };
  }
  if (scheduled - opens < 7 * DAY_MS) {
    return { ok: false, reason: "midpoint_lifetime_short", detail: "Scheduled lifetime is shorter than 7 days." };
  }
  const t0 = floorUtcToHour(Math.min(opens + 0.5 * (scheduled - opens), scheduled - 3 * DAY_MS));
  if (t0 < opens + DAY_MS) {
    return { ok: false, reason: "midpoint_window_invalid", detail: "Computed cutoff is less than 1 day after opening." };
  }
  const actual = parseUtc(question.actualCloseAt);
  if ((actual != null && actual < t0 + DAY_MS) || resolved < t0 + DAY_MS) {
    return { ok: false, reason: "midpoint_closed_early", detail: "Actual close or resolution is less than 1 day after the computed cutoff." };
  }
  return { ok: true, cutoffAt: isoUtc(t0), provenance: `scheduled-midpoint-v1 from scheduledCloseAt (${question.scheduledCloseProvenance})` };
}

export function suppliedFixedCutoff(question: ManifestQuestion): CutoffDecision {
  if (question.suppliedCutoffAt == null) {
    return { ok: false, reason: "cutoff_missing", detail: "supplied-fixed-v1 needs a cutoffAt on every evaluation question." };
  }
  return { ok: true, cutoffAt: question.suppliedCutoffAt, provenance: "supplied-fixed-v1 (retrospectively selected)" };
}

function freezeQuestion(question: ManifestQuestion, protocol: ProtocolCard, kind: DatasetKind, now: number): FrozenQuestion {
  const reasons: string[] = [];
  let cutoffAt: string | null = null;
  let evidenceCutoff: string | null = null;
  let cutoffProvenance = "not applicable (training question)";
  const opens = parseUtc(question.opensAt);
  const wording = parseUtc(question.wordingAvailableAt);
  const resolved = parseUtc(question.resolvedAt);

  if (question.outcome !== 0 && question.outcome !== 1) reasons.push("outcome_not_binary");

  if (question.role === "evaluation") {
    const decision =
      protocol.cutoffPreset === "scheduled-midpoint-v1" ? scheduledMidpointCutoff(question) : suppliedFixedCutoff(question);
    if (decision.ok) {
      cutoffAt = decision.cutoffAt;
      cutoffProvenance = decision.provenance;
      const cutoff = parseUtc(cutoffAt) as number;
      evidenceCutoff = isoUtc(cutoff - protocol.sourceBufferHours * HOUR_MS);
      // opensAt <= wordingAvailableAt <= cutoffAt < resolvedAt <= run-created time
      if (opens == null || wording == null || resolved == null || !(opens <= wording && wording <= cutoff && cutoff < resolved && resolved <= now)) {
        reasons.push("temporal_order");
      }
    } else {
      cutoffProvenance = decision.detail;
      reasons.push(decision.reason);
    }
    if (kind === "real" && question.wordingVersionProof.trim() === "") reasons.push("wording_unproven");
  } else if (opens == null || resolved == null || !(opens <= resolved && resolved <= now)) {
    reasons.push("temporal_order");
  }

  return {
    ...question,
    cutoffAt,
    evidenceCutoff,
    cutoffProvenance,
    status: reasons.length === 0 ? "eligible" : "quarantined",
    quarantineReasons: reasons,
  };
}

const QUARANTINE_DETAIL: Record<string, string> = {
  outcome_not_binary: "Outcome must be exactly 0 or 1; void, ambiguous, fractional and unresolved items fail.",
  temporal_order: "Requires opensAt <= wordingAvailableAt <= cutoffAt < resolvedAt <= freeze time.",
  wording_unproven: "Real wording needs historical availability proof; text captured after resolution is not an as-of record.",
  cutoff_missing: "supplied-fixed-v1 needs a cutoffAt.",
  midpoint_missing_schedule: "scheduled-midpoint-v1 needs a historical scheduled close with provenance.",
  midpoint_lifetime_short: "Scheduled lifetime under 7 days.",
  midpoint_window_invalid: "Computed cutoff is less than 1 day after opening; not clamped.",
  midpoint_closed_early: "Closed or resolved less than 1 day after the computed cutoff.",
};

// ---------------------------------------------------------------------------------------------
// Import entry points.

/** Parse and validate manifest JSON text, then freeze a DatasetVersion. `now` is the freeze time. */
export function importManifestText(text: string, now: string): ImportResult {
  if (utf8Length(text) > LIMITS.importBytes) {
    return { ok: false, errors: [{ path: "$", code: "import_too_large", message: "Import is limited to 1 MiB of UTF-8." }] };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, errors: [{ path: "$", code: "invalid_json", message: "The file is not valid JSON." }] };
  }
  return importManifest(value, now);
}

export function importManifest(value: unknown, now: string): ImportResult {
  const nowMs = parseUtc(now);
  if (nowMs == null) return { ok: false, errors: [{ path: "now", code: "invalid_timestamp", message: "Freeze time must be explicit UTC." }] };
  const r = new Reader();
  const root = r.obj(value, "$");
  if (root.schemaVersion !== SCHEMA_VERSION) r.fail("$.schemaVersion", "schema_unsupported", "schemaVersion must be 1.");
  const kind = root.kind;
  if (kind !== "synthetic" && kind !== "real") r.fail("$.kind", "invalid_input", "kind must be synthetic or real.");
  const datasetKind: DatasetKind = kind === "real" ? "real" : "synthetic";
  const protocol = readProtocol(r, root.protocol, datasetKind);

  const rawQuestions = r.arr(root.questions, "$.questions");
  if (rawQuestions.length > LIMITS.totalQuestions) {
    r.fail("$.questions", "import_too_large", `At most ${LIMITS.totalQuestions} questions, training included.`);
  }
  const questions = rawQuestions.slice(0, LIMITS.totalQuestions).map((q, i) => readQuestion(r, q, `$.questions[${i}]`));
  const evidence = r.arr(root.evidence, "$.evidence").map((e, i) => readEvidence(r, e, `$.evidence[${i}]`));
  const observations = r.arr(root.marketObservations, "$.marketObservations").map((o, i) =>
    readObservation(r, o, `$.marketObservations[${i}]`),
  );
  const attempts = (root.recordedAttempts == null ? [] : r.arr(root.recordedAttempts, "$.recordedAttempts")).map((a, i) =>
    readAttempt(r, a, `$.recordedAttempts[${i}]`),
  );

  // Unique IDs per collection and resolvable references.
  const questionIds = uniqueIds(r, questions, "$.questions");
  uniqueIds(r, evidence, "$.evidence");
  uniqueIds(r, observations, "$.marketObservations");
  uniqueIds(r, attempts, "$.recordedAttempts");
  const evaluationIds = new Set(questions.filter((q) => q.role === "evaluation").map((q) => q.id));
  const perQuestionEvidence = new Map<string, number>();
  evidence.forEach((item, i) => {
    if (!evaluationIds.has(item.questionId)) {
      r.fail(`$.evidence[${i}].questionId`, questionIds.has(item.questionId) ? "invalid_reference" : "unknown_reference", "Evidence must reference an evaluation question in this manifest.");
    }
    perQuestionEvidence.set(item.questionId, (perQuestionEvidence.get(item.questionId) ?? 0) + 1);
  });
  for (const [questionId, count] of perQuestionEvidence) {
    if (count > LIMITS.evidencePerQuestion) {
      r.fail("$.evidence", "import_too_large", `Question ${questionId} has ${count} evidence candidates; the limit is ${LIMITS.evidencePerQuestion}.`);
    }
  }
  const perQuestionObs = new Map<string, number>();
  observations.forEach((item, i) => {
    if (!evaluationIds.has(item.questionId)) {
      r.fail(`$.marketObservations[${i}].questionId`, "unknown_reference", "Observation must reference an evaluation question.");
    }
    perQuestionObs.set(item.questionId, (perQuestionObs.get(item.questionId) ?? 0) + 1);
  });
  for (const [questionId, count] of perQuestionObs) {
    if (count > LIMITS.observationsPerQuestion) {
      r.fail("$.marketObservations", "import_too_large", `Question ${questionId} has ${count} price observations; the limit is ${LIMITS.observationsPerQuestion}.`);
    }
  }
  const attemptSlots = new Set<string>();
  attempts.forEach((item, i) => {
    if (!evaluationIds.has(item.questionId)) {
      r.fail(`$.recordedAttempts[${i}].questionId`, "unknown_reference", "Recorded attempt must reference an evaluation question.");
    }
    const slot = `${item.questionId}|${item.arm}|${item.sequence}`;
    if (attemptSlots.has(slot)) r.fail(`$.recordedAttempts[${i}]`, "duplicate_id", "Only one recorded attempt per question, arm and sequence.");
    attemptSlots.add(slot);
  });

  const datasetId = r.str(root, "datasetId", "$");
  const name = r.str(root, "name", "$");
  const provenance = r.str(root, "provenance", "$");
  const rights = r.str(root, "rights", "$");
  if (r.issues.length > 0) return { ok: false, errors: r.issues };

  const frozen = questions.map((q) => freezeQuestion(q, protocol, datasetKind, nowMs));
  const quarantine: QuarantineRow[] = frozen.flatMap((q) =>
    q.quarantineReasons.map((reason) => ({
      targetType: "question" as const,
      targetId: q.id,
      questionId: q.id,
      reason,
      detail: QUARANTINE_DETAIL[reason] ?? reason,
    })),
  );
  const warnings: ImportIssue[] = [];
  if (protocol.cutoffPreset === "scheduled-midpoint-v1") {
    frozen.forEach((q, i) => {
      if (q.suppliedCutoffAt != null) {
        warnings.push({ path: `$.questions[${i}].cutoffAt`, code: "supplied_cutoff_ignored", message: "scheduled-midpoint-v1 computes the cutoff; the supplied value is kept for the record only." });
      }
    });
  }

  const version = freezeDatasetVersion({
    datasetId,
    name,
    kind: datasetKind,
    provenance,
    rights,
    protocol,
    questions: frozen,
    evidence,
    marketObservations: observations,
    quarantine,
    frozenAt: isoUtc(nowMs),
  });
  return { ok: true, version, recordings: attempts, recordingsHash: hashCanonical(attempts), warnings };
}

function uniqueIds(r: Reader, rows: readonly { id: string }[], path: string): Set<string> {
  const seen = new Set<string>();
  rows.forEach((row, i) => {
    if (row.id === "") return;
    if (seen.has(row.id)) r.fail(`${path}[${i}].id`, "duplicate_id", `Duplicate id ${row.id}.`);
    seen.add(row.id);
  });
  return seen;
}

type VersionBody = Omit<DatasetVersion, "schemaVersion" | "coreVersion" | "protocolHash" | "versionHash">;

export function freezeDatasetVersion(body: VersionBody): DatasetVersion {
  const protocolHash = hashCanonical(body.protocol);
  const hashed = { schemaVersion: SCHEMA_VERSION, coreVersion: CORE_VERSION, ...body, protocolHash };
  return { ...hashed, schemaVersion: 1, versionHash: hashCanonical(hashed) };
}

/** Recompute a version hash from its rows; used by Verify bundle and by resume checks. */
export function recomputeVersionHash(version: DatasetVersion): string {
  const { versionHash: _ignored, ...rest } = version;
  void _ignored;
  return hashCanonical(rest);
}

/**
 * Request/cache-key scope for a dataset version: dataset ID, protocol and the allowlisted as-of
 * question fields. Outcomes, resolution audit text, market observations and evidence rows are
 * excluded (the exact PromptEvidence hash enters the key separately).
 */
export function asOfScopeHash(version: DatasetVersion): string {
  return hashCanonical({
    datasetId: version.datasetId,
    protocolHash: version.protocolHash,
    questions: version.questions.map((q) => ({
      id: q.id,
      role: q.role,
      questionTextAsOf: q.questionTextAsOf,
      resolutionRulesAsOf: q.resolutionRulesAsOf,
      cutoffAt: q.cutoffAt,
      evidenceCutoff: q.evidenceCutoff,
    })),
  });
}

export function evaluationQuestions(version: DatasetVersion): FrozenQuestion[] {
  return version.questions.filter((q) => q.role === "evaluation");
}

export function eligibleEvaluationQuestions(version: DatasetVersion): FrozenQuestion[] {
  return evaluationQuestions(version).filter((q) => q.status === "eligible");
}

export function trainingQuestions(version: DatasetVersion): FrozenQuestion[] {
  return version.questions.filter((q) => q.role === "training" && q.status === "eligible");
}
