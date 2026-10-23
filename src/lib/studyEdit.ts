import type {
  ClaimRecord,
  ForecastRecord,
  ModelArm,
  QuestionRecord,
  SourceRecord,
  StudySet,
} from "../../supabase/functions/_shared/engine.ts";

export function patchQuestion(study: StudySet, questionId: string, patch: Partial<QuestionRecord>): StudySet {
  return {
    ...study,
    questions: study.questions.map((question) =>
      question.id === questionId ? { ...question, ...patch, id: question.id, setId: question.setId } : question,
    ),
  };
}

export function blankQuestion(setId: string): QuestionRecord {
  return {
    id: crypto.randomUUID(),
    setId,
    prompt: "New resolved yes/no question",
    cutoffAt: "2024-01-01T00:00:00.000Z",
    resolvedAt: "2024-06-01T00:00:00.000Z",
    outcome: false,
    marketPrice: 0.5,
    resolutionStatement: "Replace this with the outcome sentence.",
    modelKnowledgeCutoff: null,
  };
}

export function blankSource(questionId: string): SourceRecord {
  return {
    id: crypto.randomUUID(),
    questionId,
    title: "Untitled source",
    url: "",
    publishedAt: null,
    body: "",
  };
}

export function blankClaim(questionId: string, sourceId: string | null): ClaimRecord {
  return {
    id: crypto.randomUUID(),
    questionId,
    text: "",
    sourceId,
  };
}

export function recordedForecast(input: {
  questionId: string;
  arm: ModelArm;
  probability: number;
  rationale: string;
  claimIds: string[];
}): ForecastRecord {
  return {
    id: crypto.randomUUID(),
    questionId: input.questionId,
    arm: input.arm,
    probability: input.probability,
    origin: "recorded",
    rationale: input.rationale,
    model: null,
    claimIds: input.arm === "research" ? input.claimIds : [],
    status: "scored",
    withholdReason: null,
  };
}

export function withoutSource(study: StudySet, sourceId: string): StudySet {
  const removedClaims = new Set(study.claims.filter((claim) => claim.sourceId === sourceId).map((claim) => claim.id));
  return {
    ...study,
    sources: study.sources.filter((source) => source.id !== sourceId),
    claims: study.claims.filter((claim) => claim.sourceId !== sourceId),
    forecasts: study.forecasts.map((forecast) => ({
      ...forecast,
      claimIds: forecast.claimIds.filter((id) => !removedClaims.has(id)),
    })),
  };
}

export function withoutClaim(study: StudySet, claimId: string): StudySet {
  return {
    ...study,
    claims: study.claims.filter((claim) => claim.id !== claimId),
    forecasts: study.forecasts.map((forecast) => ({
      ...forecast,
      claimIds: forecast.claimIds.filter((id) => id !== claimId),
    })),
  };
}
