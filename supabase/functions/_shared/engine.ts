/**
 * Pure backtest rules shared by the browser and the forecast edge function.
 * No Deno, DOM, or network imports. Keep this file free of those so Vite and
 * the function can both load it.
 */

export const ARMS = ["market", "base_rate", "always_0_5", "no_research", "research"] as const;
export type ArmId = (typeof ARMS)[number];
export type ModelArm = "no_research" | "research";

export const LIVE_FORECAST_HOURLY_CAP = 20;
export const MODEL_ID = "grok-4.7";
export const RESOLUTION_PHRASE_MIN_LENGTH = 8;
export const CALIBRATION_BINS = 10;
export const PROMPT_SOURCE_LIMIT = 20;
export const PROMPT_BODY_LIMIT = 4000;
const LOG_EPS = 1e-6;

export type QuestionRecord = {
  id: string;
  setId: string;
  prompt: string;
  cutoffAt: string;
  resolvedAt: string;
  outcome: boolean;
  marketPrice: number;
  resolutionStatement: string;
  modelKnowledgeCutoff: string | null;
};

export type SourceRecord = {
  id: string;
  questionId: string;
  title: string;
  url: string;
  publishedAt: string | null;
  body: string;
};

export type ClaimRecord = {
  id: string;
  questionId: string;
  text: string;
  sourceId: string | null;
};

export type ForecastRecord = {
  id: string;
  questionId: string;
  arm: ModelArm;
  probability: number;
  origin: "recorded" | "live";
  rationale: string;
  model: string | null;
  claimIds: string[];
  status: "scored" | "withheld";
  withholdReason: string | null;
};

export type StudySet = {
  id: string;
  name: string;
  questions: QuestionRecord[];
  sources: SourceRecord[];
  claims: ClaimRecord[];
  forecasts: ForecastRecord[];
};

export type LeakCode =
  | "source_after_cutoff"
  | "source_after_resolution"
  | "source_undated"
  | "outcome_phrase"
  | "forecast_names_outcome"
  | "cutoff_not_before_resolution"
  | "market_price_out_of_range"
  | "model_memory_risk"
  | "research_no_admitted_claim"
  | "research_cites_rejected";

export type LeakFlag = {
  code: LeakCode;
  targetType: "question" | "source" | "forecast";
  targetId: string;
  detail: string;
};

export type SourceAdmission = {
  sourceId: string;
  admitted: boolean;
  reason: "ok" | "undated" | "after_cutoff" | "unparseable_cutoff";
};

export type CriticReason =
  | "ok"
  | "empty"
  | "missing_source"
  | "unknown_source"
  | "wrong_question"
  | "undated_source"
  | "source_after_cutoff"
  | "source_leaked";

export type CriticVerdict = {
  claimId: string;
  admitted: boolean;
  reason: CriticReason;
};

export type ScoredPair = {
  probability: number;
  outcome: 0 | 1;
};

export type CalibrationBin = {
  index: number;
  lower: number;
  upper: number;
  count: number;
  meanProbability: number | null;
  frequency: number | null;
};

export type MurphySplit = {
  reliability: number;
  resolution: number;
  uncertainty: number;
  binnedBrier: number;
};

export type ArmDecision = {
  arm: ArmId;
  probability: number | null;
  scored: boolean;
  reason: string;
};

export type QuestionReport = {
  questionId: string;
  eligible: boolean;
  flags: LeakFlag[];
  sourceAdmissions: SourceAdmission[];
  critic: CriticVerdict[];
  arms: ArmDecision[];
};

export type ArmSummary = {
  arm: ArmId;
  count: number;
  brier: number | null;
  logLoss: number | null;
  brierSkillVsAlwaysHalf: number | null;
  ece: number | null;
  murphy: MurphySplit | null;
  bins: CalibrationBin[];
};

export type BacktestReport = {
  questions: QuestionReport[];
  arms: ArmSummary[];
};

export type ParsedModelForecast = {
  probability: number;
  rationale: string;
  claims: { text: string; sourceId: string }[];
};

export function parseTime(value: string | null | undefined): number | null {
  if (value == null) return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const ms = Date.parse(trimmed);
  return Number.isNaN(ms) ? null : ms;
}

export function admitSource(source: SourceRecord, cutoffAt: string): SourceAdmission {
  const cutoff = parseTime(cutoffAt);
  if (cutoff == null) {
    return { sourceId: source.id, admitted: false, reason: "unparseable_cutoff" };
  }
  const published = parseTime(source.publishedAt);
  if (published == null) {
    return { sourceId: source.id, admitted: false, reason: "undated" };
  }
  if (published > cutoff) {
    return { sourceId: source.id, admitted: false, reason: "after_cutoff" };
  }
  return { sourceId: source.id, admitted: true, reason: "ok" };
}

export function containsResolutionPhrase(text: string, resolutionStatement: string): boolean {
  const needle = resolutionStatement.trim().toLowerCase();
  if (needle.length < RESOLUTION_PHRASE_MIN_LENGTH) return false;
  return text.toLowerCase().includes(needle);
}

export function questionEligibility(question: QuestionRecord): { eligible: boolean; flags: LeakFlag[] } {
  const flags: LeakFlag[] = [];
  const cutoff = parseTime(question.cutoffAt);
  const resolved = parseTime(question.resolvedAt);
  if (cutoff == null || resolved == null || cutoff >= resolved) {
    flags.push({
      code: "cutoff_not_before_resolution",
      targetType: "question",
      targetId: question.id,
      detail: "The cutoff must be a real time strictly before resolution.",
    });
  }
  if (!Number.isFinite(question.marketPrice) || question.marketPrice < 0 || question.marketPrice > 1) {
    flags.push({
      code: "market_price_out_of_range",
      targetType: "question",
      targetId: question.id,
      detail: "The YES price at the cutoff must be between 0 and 1.",
    });
  }
  const memory = parseTime(question.modelKnowledgeCutoff);
  if (memory != null && cutoff != null && memory > cutoff) {
    flags.push({
      code: "model_memory_risk",
      targetType: "question",
      targetId: question.id,
      detail:
        "The declared model knowledge cutoff is after the forecast cutoff, so the model may already have seen the outcome.",
    });
  }
  const blocking = flags.some((flag) => flag.code !== "model_memory_risk");
  return { eligible: !blocking, flags };
}

export function sourceFlags(question: QuestionRecord, source: SourceRecord): LeakFlag[] {
  const flags: LeakFlag[] = [];
  const admission = admitSource(source, question.cutoffAt);
  if (admission.reason === "undated" || admission.reason === "unparseable_cutoff") {
    flags.push({
      code: "source_undated",
      targetType: "source",
      targetId: source.id,
      detail: "No usable published time at or before the cutoff.",
    });
  }
  if (admission.reason === "after_cutoff") {
    flags.push({
      code: "source_after_cutoff",
      targetType: "source",
      targetId: source.id,
      detail: "Published after the forecast cutoff.",
    });
  }
  const published = parseTime(source.publishedAt);
  const resolved = parseTime(question.resolvedAt);
  if (published != null && resolved != null && published > resolved) {
    flags.push({
      code: "source_after_resolution",
      targetType: "source",
      targetId: source.id,
      detail: "Published after the question resolved.",
    });
  }
  if (containsResolutionPhrase(`${source.title}\n${source.body}`, question.resolutionStatement)) {
    flags.push({
      code: "outcome_phrase",
      targetType: "source",
      targetId: source.id,
      detail: "The source text contains the resolution sentence.",
    });
  }
  return flags;
}

export function reviewClaim(
  question: QuestionRecord,
  sources: readonly SourceRecord[],
  claim: ClaimRecord,
): CriticVerdict {
  if (claim.text.trim() === "") {
    return { claimId: claim.id, admitted: false, reason: "empty" };
  }
  if (claim.questionId !== question.id) {
    return { claimId: claim.id, admitted: false, reason: "wrong_question" };
  }
  if (claim.sourceId == null || claim.sourceId === "") {
    return { claimId: claim.id, admitted: false, reason: "missing_source" };
  }
  const source = sources.find((item) => item.id === claim.sourceId);
  if (source == null || source.questionId !== question.id) {
    return { claimId: claim.id, admitted: false, reason: "unknown_source" };
  }
  const admission = admitSource(source, question.cutoffAt);
  if (!admission.admitted) {
    return {
      claimId: claim.id,
      admitted: false,
      reason: admission.reason === "after_cutoff" ? "source_after_cutoff" : "undated_source",
    };
  }
  const leaked = sourceFlags(question, source).some(
    (flag) => flag.code === "outcome_phrase" || flag.code === "source_after_resolution",
  );
  if (leaked) {
    return { claimId: claim.id, admitted: false, reason: "source_leaked" };
  }
  return { claimId: claim.id, admitted: true, reason: "ok" };
}

export function selectPromptSources(question: QuestionRecord, sources: readonly SourceRecord[]): SourceRecord[] {
  return sources.filter((source) => {
    if (source.questionId !== question.id) return false;
    if (!admitSource(source, question.cutoffAt).admitted) return false;
    if (containsResolutionPhrase(`${source.title}\n${source.body}`, question.resolutionStatement)) return false;
    const published = parseTime(source.publishedAt);
    const resolved = parseTime(question.resolvedAt);
    if (published != null && resolved != null && published > resolved) return false;
    return true;
  });
}

export function buildForecastPrompt(
  question: QuestionRecord,
  sources: readonly SourceRecord[],
  arm: ModelArm,
): { system: string; user: string } {
  const admitted = (arm === "research" ? selectPromptSources(question, sources) : [])
    .slice(0, PROMPT_SOURCE_LIMIT)
    .map((source) => ({
      ...source,
      body:
        source.body.length > PROMPT_BODY_LIMIT
          ? `${source.body.slice(0, PROMPT_BODY_LIMIT)} [truncated]`
          : source.body,
    }));
  const system = [
    "You are scoring a resolved yes/no question as of a cutoff.",
    "Use only the cutoff and, when arm is research, the sources in the user message.",
    "Do not rely on events after cutoff_at.",
    "Return one JSON object and nothing else.",
    'Keys: "probability" (number from 0 to 1, the chance the question resolves yes), "rationale" (string), "claims" (array).',
    'Each claim is {"text": string, "source_id": string}.',
    "When arm is no_research, claims must be an empty array.",
    "When arm is research, every claim must use a source_id from the supplied sources.",
    "If you cannot support a research claim with one of those sources, omit that claim.",
  ].join(" ");
  const user = JSON.stringify({
    arm,
    cutoff_at: question.cutoffAt,
    question: question.prompt,
    sources: admitted.map((source) => ({
      id: source.id,
      title: source.title,
      published_at: source.publishedAt,
      body: source.body,
    })),
  });
  return { system, user };
}

export function parseModelPayload(content: string): ParsedModelForecast | null {
  const trimmed = content.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const body = fenced != null ? fenced[1] : trimmed;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let value: unknown;
  try {
    value = JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
  if (value == null || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const probability = record.probability;
  if (typeof probability !== "number" || !Number.isFinite(probability) || probability < 0 || probability > 1) {
    return null;
  }
  if (typeof record.rationale !== "string") return null;
  if (!Array.isArray(record.claims)) return null;
  const claims: { text: string; sourceId: string }[] = [];
  for (const item of record.claims) {
    if (item == null || typeof item !== "object") return null;
    const claim = item as Record<string, unknown>;
    if (typeof claim.text !== "string" || typeof claim.source_id !== "string") return null;
    claims.push({ text: claim.text, sourceId: claim.source_id });
  }
  return { probability, rationale: record.rationale, claims };
}

export function baseRateAtCutoff(questions: readonly QuestionRecord[], question: QuestionRecord): number | null {
  const cutoff = parseTime(question.cutoffAt);
  if (cutoff == null) return null;
  const prior = questions.filter((other) => {
    if (other.id === question.id || other.setId !== question.setId) return false;
    const resolved = parseTime(other.resolvedAt);
    return resolved != null && resolved <= cutoff;
  });
  if (prior.length === 0) return null;
  return prior.filter((other) => other.outcome).length / prior.length;
}

export function brierScore(pairs: readonly ScoredPair[]): number | null {
  if (pairs.length === 0) return null;
  const total = pairs.reduce((sum, pair) => sum + (pair.probability - pair.outcome) ** 2, 0);
  return total / pairs.length;
}

export function logLoss(pairs: readonly ScoredPair[]): number | null {
  if (pairs.length === 0) return null;
  const total = pairs.reduce((sum, pair) => {
    const probability = Math.min(1 - LOG_EPS, Math.max(LOG_EPS, pair.probability));
    const outcome = pair.outcome;
    return sum + -(outcome * Math.log(probability) + (1 - outcome) * Math.log(1 - probability));
  }, 0);
  return total / pairs.length;
}

export function brierSkill(score: number | null, reference: number | null): number | null {
  if (score == null || reference == null || reference === 0) return null;
  return 1 - score / reference;
}

export function calibrationBins(pairs: readonly ScoredPair[], binCount = CALIBRATION_BINS): CalibrationBin[] {
  const bins: CalibrationBin[] = [];
  for (let index = 0; index < binCount; index += 1) {
    const lower = index / binCount;
    const upper = (index + 1) / binCount;
    const members = pairs.filter((pair) => {
      if (index === binCount - 1) {
        return pair.probability >= lower && pair.probability <= upper;
      }
      return pair.probability >= lower && pair.probability < upper;
    });
    const count = members.length;
    bins.push({
      index,
      lower,
      upper,
      count,
      meanProbability: count === 0 ? null : members.reduce((sum, pair) => sum + pair.probability, 0) / count,
      frequency: count === 0 ? null : members.reduce((sum, pair) => sum + pair.outcome, 0) / count,
    });
  }
  return bins;
}

export function expectedCalibrationError(pairs: readonly ScoredPair[], binCount = CALIBRATION_BINS): number | null {
  if (pairs.length === 0) return null;
  return calibrationBins(pairs, binCount).reduce((sum, bin) => {
    if (bin.count === 0 || bin.meanProbability == null || bin.frequency == null) return sum;
    return sum + (bin.count / pairs.length) * Math.abs(bin.frequency - bin.meanProbability);
  }, 0);
}

/** Murphy split on the same bins as the reliability diagram. It matches the binned Brier, not every raw Brier. */
export function murphySplit(pairs: readonly ScoredPair[], binCount = CALIBRATION_BINS): MurphySplit | null {
  if (pairs.length === 0) return null;
  const bins = calibrationBins(pairs, binCount).filter(
    (bin) => bin.count > 0 && bin.meanProbability != null && bin.frequency != null,
  );
  const baseRate = pairs.reduce((sum, pair) => sum + pair.outcome, 0) / pairs.length;
  const uncertainty = baseRate * (1 - baseRate);
  const reliability = bins.reduce((sum, bin) => {
    const gap = (bin.meanProbability as number) - (bin.frequency as number);
    return sum + (bin.count / pairs.length) * gap * gap;
  }, 0);
  const resolution = bins.reduce((sum, bin) => {
    const gap = (bin.frequency as number) - baseRate;
    return sum + (bin.count / pairs.length) * gap * gap;
  }, 0);
  return {
    reliability,
    resolution,
    uncertainty,
    binnedBrier: reliability - resolution + uncertainty,
  };
}

function latestForecast(
  forecasts: readonly ForecastRecord[],
  questionId: string,
  arm: ModelArm,
): ForecastRecord | null {
  const matches = forecasts.filter((item) => item.questionId === questionId && item.arm === arm);
  if (matches.length === 0) return null;
  return matches[matches.length - 1] ?? null;
}

function decideModelArm(
  question: QuestionRecord,
  forecast: ForecastRecord | null,
  critic: readonly CriticVerdict[],
  flags: LeakFlag[],
  arm: ModelArm,
): ArmDecision {
  if (forecast == null) {
    return { arm, probability: null, scored: false, reason: "No forecast was recorded for this arm." };
  }
  if (!Number.isFinite(forecast.probability) || forecast.probability < 0 || forecast.probability > 1) {
    return { arm, probability: null, scored: false, reason: "Probability is outside [0, 1]." };
  }
  if (containsResolutionPhrase(forecast.rationale, question.resolutionStatement)) {
    flags.push({
      code: "forecast_names_outcome",
      targetType: "forecast",
      targetId: forecast.id,
      detail: "The rationale contains the resolution sentence.",
    });
    return {
      arm,
      probability: forecast.probability,
      scored: false,
      reason: "Rationale contains the resolution sentence.",
    };
  }
  if (arm === "research") {
    const attached = forecast.claimIds
      .map((id) => critic.find((verdict) => verdict.claimId === id))
      .filter((verdict): verdict is CriticVerdict => verdict != null);
    const admitted = attached.filter((verdict) => verdict.admitted);
    const rejected = attached.filter((verdict) => !verdict.admitted);
    if (rejected.length > 0) {
      flags.push({
        code: "research_cites_rejected",
        targetType: "forecast",
        targetId: forecast.id,
        detail: `${rejected.length} attached claim(s) failed the critic.`,
      });
    }
    if (admitted.length === 0) {
      flags.push({
        code: "research_no_admitted_claim",
        targetType: "forecast",
        targetId: forecast.id,
        detail: "A research forecast needs at least one claim that cites an admitted source.",
      });
      return {
        arm,
        probability: forecast.probability,
        scored: false,
        reason: "No admitted claim. The probability is kept and not scored.",
      };
    }
  }
  if (forecast.status === "withheld") {
    return {
      arm,
      probability: forecast.probability,
      scored: false,
      reason: forecast.withholdReason ?? "Stored as withheld.",
    };
  }
  return { arm, probability: forecast.probability, scored: true, reason: "Scored." };
}

export function runBacktest(study: StudySet): BacktestReport {
  const questions = study.questions.map((question) => {
    const eligibility = questionEligibility(question);
    const questionSources = study.sources.filter((source) => source.questionId === question.id);
    const questionClaims = study.claims.filter((claim) => claim.questionId === question.id);
    const flags = [...eligibility.flags, ...questionSources.flatMap((source) => sourceFlags(question, source))];
    const critic = questionClaims.map((claim) => reviewClaim(question, questionSources, claim));
    if (!eligibility.eligible) {
      return {
        questionId: question.id,
        eligible: false,
        flags,
        sourceAdmissions: questionSources.map((source) => admitSource(source, question.cutoffAt)),
        critic,
        arms: ARMS.map((arm) => ({
          arm,
          probability: null,
          scored: false,
          reason: "Question is outside the backtest rules.",
        })),
      };
    }
    const base = baseRateAtCutoff(study.questions, question);
    const arms: ArmDecision[] = [
      {
        arm: "market",
        probability: question.marketPrice,
        scored: true,
        reason: "YES price stored at the cutoff.",
      },
      base == null
        ? {
            arm: "base_rate",
            probability: null,
            scored: false,
            reason: "No other question in this set had resolved by the cutoff.",
          }
        : {
            arm: "base_rate",
            probability: base,
            scored: true,
            reason: "YES rate among other questions already resolved by the cutoff.",
          },
      {
        arm: "always_0_5",
        probability: 0.5,
        scored: true,
        reason: "Constant baseline. A missing model forecast is not rewritten to 0.5.",
      },
      decideModelArm(question, latestForecast(study.forecasts, question.id, "no_research"), critic, flags, "no_research"),
      decideModelArm(question, latestForecast(study.forecasts, question.id, "research"), critic, flags, "research"),
    ];
    return {
      questionId: question.id,
      eligible: true,
      flags,
      sourceAdmissions: questionSources.map((source) => admitSource(source, question.cutoffAt)),
      critic,
      arms,
    };
  });

  const arms = ARMS.map((arm) => summarizeArm(study, questions, arm));
  return { questions, arms };
}

function summarizeArm(study: StudySet, questions: readonly QuestionReport[], arm: ArmId): ArmSummary {
  const pairs: ScoredPair[] = [];
  for (const report of questions) {
    const decision = report.arms.find((item) => item.arm === arm);
    const question = study.questions.find((item) => item.id === report.questionId);
    if (decision == null || question == null || !decision.scored || decision.probability == null) continue;
    pairs.push({ probability: decision.probability, outcome: question.outcome ? 1 : 0 });
  }
  const score = brierScore(pairs);
  const reference = brierScore(pairs.map((pair) => ({ probability: 0.5, outcome: pair.outcome })));
  return {
    arm,
    count: pairs.length,
    brier: score,
    logLoss: logLoss(pairs),
    brierSkillVsAlwaysHalf: brierSkill(score, reference),
    ece: expectedCalibrationError(pairs),
    murphy: murphySplit(pairs),
    bins: calibrationBins(pairs),
  };
}
