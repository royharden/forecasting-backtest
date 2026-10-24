/**
 * ForecastInput allowlist, prompt construction, model profile guards and request/cache keys
 * (PLAN.md s.2 "Outcome-aware audits are separate" and s.4 forecast contract).
 *
 * ForecastInput is built from an explicit allowlist of as-of fields. Outcome, resolution audit
 * text, market observations and other arms' predictions are not reachable from these functions,
 * so changing them cannot change a serialized model request.
 */

import { canonicalJson, hashCanonical, isStorableText } from "./canonical.ts";
import type { PromptEvidence } from "./evidence.ts";
import { GATE_VERSION, LIMITS, PROMPT_VERSION, type ModelArm } from "./manifest.ts";
import { parseUtc } from "./time.ts";

export const STRUCTURAL_CODES = [
  "empty",
  "unknown_source",
  "truncated_away",
  "span_not_in_excerpt",
  "hash_mismatch",
  "invalid_offset",
] as const;
export type StructuralCode = (typeof STRUCTURAL_CODES)[number];

/** Correction feedback: claim index and a non-revealing structural code only. */
export type StructuralFeedback = { claimIndex: number; code: StructuralCode };

/** The only question fields a prompt may read. */
export type AsOfQuestion = {
  id: string;
  questionTextAsOf: string;
  resolutionRulesAsOf: string;
  cutoffAt: string;
};

export type PromptEvidenceView = {
  evidenceId: string;
  title: string;
  published: string;
  excerpt: string;
  excerptHash: string;
};

export type ForecastInput = {
  schema: "forecast-input-1";
  promptVersion: string;
  arm: ModelArm;
  questionId: string;
  questionTextAsOf: string;
  resolutionRulesAsOf: string;
  forecastAsOf: string;
  evidence: PromptEvidenceView[];
};

/** Explicit allowlist. Accepts a wider object but copies only the named as-of fields. */
export function buildForecastInput(question: AsOfQuestion, promptEvidence: readonly PromptEvidence[], arm: ModelArm): ForecastInput {
  return {
    schema: "forecast-input-1",
    promptVersion: PROMPT_VERSION,
    arm,
    questionId: question.id,
    questionTextAsOf: question.questionTextAsOf,
    resolutionRulesAsOf: question.resolutionRulesAsOf,
    forecastAsOf: question.cutoffAt,
    evidence:
      arm === "research"
        ? promptEvidence.map((item) => ({
            evidenceId: item.evidenceId,
            title: item.title,
            published: item.published,
            excerpt: item.excerpt,
            excerptHash: item.excerptHash,
          }))
        : [],
  };
}

export type ChatMessage = { role: "system" | "user"; content: string };

const SYSTEM_FRAMING = [
  "You are forecasting a yes/no question as it stood at the forecast time given as forecast_as_of.",
  "Treat the question as still open at that time. The wording and rules are the historical versions available then.",
  "Use only the question, its rules and, for the research arm, the supplied excerpts. You have no tools and no browsing.",
  "Return exactly one JSON object and nothing else, with keys probability, rationale and claims.",
  "probability: number from 0 to 1, the chance the question resolves YES under its rules.",
  `rationale: string of at most ${LIMITS.rationaleChars} characters.`,
  "claims: array of {text, evidenceId, start, end, contentHash}.",
  "Each claim text must be copied exactly, character for character, from one supplied excerpt.",
  "start and end are JavaScript UTF-16 string indices so that excerpt.slice(start, end) equals text; contentHash is that excerpt's excerptHash.",
  `For the research arm give 1 to ${LIMITS.claimsMax} claims and attach no factual claim that is not such an exact quote.`,
  "For the no_research arm claims must be an empty array.",
].join(" ");

/** Messages for one bounded model call. Correction feedback carries only claim indices and codes. */
export function buildMessages(input: ForecastInput, feedback: readonly StructuralFeedback[] | null): ChatMessage[] {
  const user: Record<string, unknown> = {
    arm: input.arm,
    forecast_as_of: input.forecastAsOf,
    question: input.questionTextAsOf,
    resolution_rules: input.resolutionRulesAsOf,
    excerpts: input.evidence,
  };
  if (feedback != null) {
    user.correction = {
      note: "Your previous answer had structural claim problems. Answer again from the same inputs. Listed codes refer to claim positions in that answer.",
      problems: feedback.map((item) => ({ claimIndex: item.claimIndex, code: item.code })),
    };
  }
  return [
    { role: "system", content: SYSTEM_FRAMING },
    { role: "user", content: canonicalJson(user) },
  ];
}

// ---------------------------------------------------------------------------------------------
// Model profile and send-time guards.

export const XAI_ENDPOINT = "https://api.x.ai/v1/chat/completions";

export type ModelPricing = {
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
  /** Whether hidden reasoning tokens are billed and bounded by maxOutputTokens. */
  reasoningBilling: "verified_within_output_cap" | "unknown";
  /** Verified worst-case tokens per UTF-8 byte of input, including special-token overhead. */
  maxInputTokensPerByte: number | null;
  verifiedAt: string | null;
};

export type ModelProfile = {
  profileVersion: string;
  provider: "xai";
  endpoint: typeof XAI_ENDPOINT;
  modelId: string;
  declaredTrainingCutoff: string | null;
  trainingCutoffSource: string | null;
  trainingCutoffConfirmedAt: string | null;
  promptVersion: string;
  temperature: number;
  maxOutputTokens: number;
  jsonResponseFormat: boolean;
  pricing: ModelPricing | null;
};

export type LiveEligibility = { eligible: boolean; reasons: string[] };

/**
 * Live enablement requires a declared cutoff with source and confirmation date, verified pricing,
 * token and reasoning-billing metadata, and a declared cutoff before every evaluation item opened.
 */
export function liveEligibility(profile: ModelProfile, evaluationOpens: readonly string[], allowlist: readonly string[]): LiveEligibility {
  const reasons: string[] = [];
  if (!allowlist.includes(profile.modelId)) reasons.push("model_not_allowlisted");
  if (isOnlineVariant(profile.modelId)) reasons.push("online_model_variant");
  if (profile.promptVersion !== PROMPT_VERSION) reasons.push("prompt_version_mismatch");
  if (profile.maxOutputTokens > LIMITS.outputTokenMax || profile.maxOutputTokens < 1) reasons.push("output_cap_invalid");
  const cutoff = parseUtc(profile.declaredTrainingCutoff);
  if (cutoff == null) reasons.push("training_cutoff_unknown");
  if (!profile.trainingCutoffSource || parseUtc(profile.trainingCutoffConfirmedAt) == null) reasons.push("training_cutoff_unconfirmed");
  const pricing = profile.pricing;
  if (
    pricing == null ||
    pricing.reasoningBilling !== "verified_within_output_cap" ||
    pricing.maxInputTokensPerByte == null ||
    !(pricing.inputUsdPerMTok >= 0) ||
    !(pricing.outputUsdPerMTok >= 0) ||
    parseUtc(pricing.verifiedAt) == null
  ) {
    reasons.push("pricing_or_tokenization_unverified");
  }
  if (cutoff != null && evaluationOpens.some((opens) => (parseUtc(opens) ?? -Infinity) <= cutoff)) {
    reasons.push("training_cutoff_not_before_question_open");
  }
  return { eligible: reasons.length === 0, reasons };
}

export function isOnlineVariant(modelId: string): boolean {
  return /(?:online|search|brows|web|live)/i.test(modelId);
}

/** Worst-case USD for one call: verified per-byte token bound on input plus the full output cap. */
export function worstCaseCallUsd(profile: ModelProfile, requestBytes: number): number | null {
  const pricing = profile.pricing;
  if (pricing == null || pricing.maxInputTokensPerByte == null || pricing.reasoningBilling !== "verified_within_output_cap") return null;
  const inputTokens = Math.ceil(requestBytes * pricing.maxInputTokensPerByte);
  return (inputTokens * pricing.inputUsdPerMTok + profile.maxOutputTokens * pricing.outputUsdPerMTok) / 1_000_000;
}

export type ProviderPayload = {
  model: string;
  messages: ChatMessage[];
  temperature: number;
  max_tokens: number;
  stream: false;
  response_format?: { type: "json_object" };
};

const ALLOWED_PAYLOAD_KEYS = new Set(["model", "messages", "temperature", "max_tokens", "stream", "response_format"]);

export function buildProviderPayload(profile: ModelProfile, messages: ChatMessage[]): ProviderPayload {
  const payload: ProviderPayload = {
    model: profile.modelId,
    messages,
    temperature: profile.temperature,
    max_tokens: Math.min(profile.maxOutputTokens, LIMITS.outputTokenMax),
    stream: false,
  };
  if (profile.jsonResponseFormat) payload.response_format = { type: "json_object" };
  return payload;
}

/** Reject tools, plugins, native search parameters and online variants at send time. */
export function assertNoBrowsingPayload(payload: Record<string, unknown>, allowlist: readonly string[]): string | null {
  for (const key of Object.keys(payload)) {
    if (!ALLOWED_PAYLOAD_KEYS.has(key)) return `payload_key_forbidden:${key}`;
  }
  const model = payload.model;
  if (typeof model !== "string" || !allowlist.includes(model)) return "model_not_allowlisted";
  if (isOnlineVariant(model)) return "online_model_variant";
  if (payload.stream !== false) return "stream_forbidden";
  const messages = payload.messages;
  if (!Array.isArray(messages)) return "messages_invalid";
  for (const message of messages) {
    if (message == null || typeof message !== "object") return "messages_invalid";
    const keys = Object.keys(message);
    if (keys.some((key) => key !== "role" && key !== "content")) return "message_key_forbidden";
    const role = (message as { role?: unknown }).role;
    if (role !== "system" && role !== "user") return "message_role_forbidden";
  }
  return null;
}

export type ProviderReading =
  | { ok: true; content: string; usage: { promptTokens: number | null; completionTokens: number | null }; providerRequestId: string | null }
  | { ok: false; code: "tool_call_response" | "empty_response" | "response_schema_invalid" };

/** Inspect a parsed chat-completions body. Any tool-call or citation/search material is rejected. */
export function readProviderResponse(body: unknown): ProviderReading {
  if (body == null || typeof body !== "object") return { ok: false, code: "response_schema_invalid" };
  const record = body as Record<string, unknown>;
  if ("citations" in record || "search_results" in record || "tool_calls" in record) return { ok: false, code: "tool_call_response" };
  const choices = record.choices;
  if (!Array.isArray(choices) || choices.length !== 1) return { ok: false, code: "response_schema_invalid" };
  const choice = choices[0] as Record<string, unknown> | null;
  if (choice == null || typeof choice !== "object") return { ok: false, code: "response_schema_invalid" };
  if (choice.finish_reason === "tool_calls" || choice.finish_reason === "function_call") return { ok: false, code: "tool_call_response" };
  const message = choice.message as Record<string, unknown> | null;
  if (message == null || typeof message !== "object") return { ok: false, code: "response_schema_invalid" };
  const toolCalls = message.tool_calls;
  if ((Array.isArray(toolCalls) && toolCalls.length > 0) || message.function_call != null) return { ok: false, code: "tool_call_response" };
  const content = message.content;
  if (typeof content !== "string" || content.trim() === "") return { ok: false, code: "empty_response" };
  // U+0000 and lone surrogates cannot be stored in Postgres text/jsonb: an invalid response, not a write error.
  if (!isStorableText(content)) return { ok: false, code: "response_schema_invalid" };
  const usage = (record.usage ?? {}) as Record<string, unknown>;
  const tokens = (value: unknown) => (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 10_000_000 ? value : null);
  const requestId = typeof record.id === "string" && record.id.length <= 256 && isStorableText(record.id) ? record.id : null;
  return {
    ok: true,
    content,
    usage: {
      promptTokens: tokens(usage.prompt_tokens),
      completionTokens: tokens(usage.completion_tokens),
    },
    providerRequestId: requestId,
  };
}

// ---------------------------------------------------------------------------------------------
// Request / cache key.

export type RequestKeyParts = {
  ownerId: string;
  /** asOfScopeHash(version): dataset identity and as-of fields only, never outcomes/prices/audit text. */
  datasetScope: string;
  profile: ModelProfile;
  input: ForecastInput;
  promptEvidenceHash: string;
  feedback: readonly StructuralFeedback[] | null;
};

/**
 * SHA-256 of the canonical allowed payload plus provider/model/settings, prompt/gate versions and
 * the exact PromptEvidence hash, scoped to owner and dataset version. No secrets, outcomes,
 * prices or audit fields are reachable here.
 */
export function computeRequestKey(parts: RequestKeyParts): string {
  return hashCanonical({
    owner: parts.ownerId,
    datasetScope: parts.datasetScope,
    provider: parts.profile.provider,
    endpoint: parts.profile.endpoint,
    modelId: parts.profile.modelId,
    settings: {
      temperature: parts.profile.temperature,
      maxOutputTokens: parts.profile.maxOutputTokens,
      jsonResponseFormat: parts.profile.jsonResponseFormat,
    },
    promptVersion: PROMPT_VERSION,
    gateVersion: GATE_VERSION,
    promptEvidenceHash: parts.promptEvidenceHash,
    messages: buildMessages(parts.input, parts.feedback),
  });
}
