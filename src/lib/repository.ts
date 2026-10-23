import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  ClaimRecord,
  ForecastRecord,
  QuestionRecord,
  SourceRecord,
  StudySet,
} from "../../supabase/functions/_shared/engine.ts";
import { getSupabase } from "./supabaseClient";

export type SetSummary = { id: string; name: string };
export type RunSummary = { id: string; label: string; createdAt: string };

type QuestionRow = {
  id: string;
  set_id: string;
  prompt: string;
  cutoff_at: string;
  resolved_at: string;
  outcome: boolean;
  market_price: number | string;
  resolution_statement: string;
  model_knowledge_cutoff: string | null;
};

type SourceRow = {
  id: string;
  question_id: string;
  title: string;
  url: string;
  published_at: string | null;
  body: string;
};

type ClaimRow = {
  id: string;
  question_id: string;
  text: string;
  source_id: string | null;
};

type ForecastRow = {
  id: string;
  question_id: string;
  arm: "no_research" | "research";
  probability: number | string;
  origin: "recorded" | "live";
  rationale: string;
  model: string | null;
  status: "scored" | "withheld";
  withhold_reason: string | null;
  claim_ids: string[] | null;
  created_at: string;
};

function client(): SupabaseClient {
  const supabase = getSupabase();
  if (supabase == null) throw new Error("Supabase is not configured. The browser demo does not store data.");
  return supabase;
}

async function userId(supabase: SupabaseClient): Promise<string> {
  const { data, error } = await supabase.auth.getUser();
  if (error != null || data.user == null) throw new Error("Sign in before storing a study set.");
  return data.user.id;
}

function raise(error: { message: string } | null, action: string): void {
  if (error != null) throw new Error(`${action}: ${error.message}`);
}

function asQuestion(row: QuestionRow): QuestionRecord {
  return {
    id: row.id,
    setId: row.set_id,
    prompt: row.prompt,
    cutoffAt: row.cutoff_at,
    resolvedAt: row.resolved_at,
    outcome: row.outcome,
    marketPrice: Number(row.market_price),
    resolutionStatement: row.resolution_statement,
    modelKnowledgeCutoff: row.model_knowledge_cutoff,
  };
}

function asSource(row: SourceRow): SourceRecord {
  return {
    id: row.id,
    questionId: row.question_id,
    title: row.title,
    url: row.url,
    publishedAt: row.published_at,
    body: row.body,
  };
}

function asClaim(row: ClaimRow): ClaimRecord {
  return {
    id: row.id,
    questionId: row.question_id,
    text: row.text,
    sourceId: row.source_id,
  };
}

function asForecast(row: ForecastRow): ForecastRecord {
  return {
    id: row.id,
    questionId: row.question_id,
    arm: row.arm,
    probability: Number(row.probability),
    origin: row.origin,
    rationale: row.rationale,
    model: row.model,
    claimIds: row.claim_ids ?? [],
    status: row.status,
    withholdReason: row.withhold_reason,
  };
}

function questionPayload(question: QuestionRecord, owner: string) {
  return {
    id: question.id,
    set_id: question.setId,
    user_id: owner,
    prompt: question.prompt,
    cutoff_at: question.cutoffAt,
    resolved_at: question.resolvedAt,
    outcome: question.outcome,
    market_price: question.marketPrice,
    resolution_statement: question.resolutionStatement,
    model_knowledge_cutoff: question.modelKnowledgeCutoff,
  };
}

export async function listSets(): Promise<SetSummary[]> {
  const supabase = client();
  const { data, error } = await supabase.from("study_sets").select("id, name").order("created_at", { ascending: false });
  raise(error, "Could not list study sets");
  return (data ?? []) as SetSummary[];
}

export async function loadSet(setId: string): Promise<StudySet> {
  const supabase = client();
  const { data: setRow, error: setError } = await supabase.from("study_sets").select("id, name").eq("id", setId).maybeSingle();
  raise(setError, "Could not load the study set");
  if (setRow == null) throw new Error("That study set is not on this account.");

  const questions = await selectRows<QuestionRow>(supabase, "questions", "set_id", setId, "cutoff_at");
  const questionIds = questions.map((row) => row.id);
  const sources = questionIds.length === 0 ? [] : await selectIn<SourceRow>(supabase, "sources", questionIds);
  const claims = questionIds.length === 0 ? [] : await selectIn<ClaimRow>(supabase, "claims", questionIds);
  const forecasts = questionIds.length === 0 ? [] : await selectIn<ForecastRow>(supabase, "forecasts", questionIds, "created_at");

  return {
    id: setRow.id as string,
    name: setRow.name as string,
    questions: questions.map(asQuestion),
    sources: sources.map(asSource),
    claims: claims.map(asClaim),
    forecasts: forecasts.map(asForecast),
  };
}

async function selectRows<T>(
  supabase: SupabaseClient,
  table: string,
  column: string,
  value: string,
  orderColumn: string,
): Promise<T[]> {
  const { data, error } = await supabase.from(table).select("*").eq(column, value).order(orderColumn, { ascending: true });
  raise(error, `Could not load ${table}`);
  return (data ?? []) as T[];
}

async function selectIn<T>(
  supabase: SupabaseClient,
  table: string,
  questionIds: string[],
  orderColumn = "created_at",
): Promise<T[]> {
  const { data, error } = await supabase
    .from(table)
    .select("*")
    .in("question_id", questionIds)
    .order(orderColumn, { ascending: true });
  raise(error, `Could not load ${table}`);
  return (data ?? []) as T[];
}

export async function createEmptySet(name: string): Promise<StudySet> {
  const supabase = client();
  const owner = await userId(supabase);
  const id = crypto.randomUUID();
  const { error } = await supabase.from("study_sets").insert({ id, user_id: owner, name });
  raise(error, "Could not create the study set");
  return { id, name, questions: [], sources: [], claims: [], forecasts: [] };
}

export async function saveStudyCopy(study: StudySet): Promise<StudySet> {
  const supabase = client();
  const owner = await userId(supabase);
  const setId = crypto.randomUUID();
  const questionIds = new Map(study.questions.map((question) => [question.id, crypto.randomUUID()]));
  const sourceIds = new Map(study.sources.map((source) => [source.id, crypto.randomUUID()]));
  const claimIds = new Map(study.claims.map((claim) => [claim.id, crypto.randomUUID()]));

  const { error: setError } = await supabase.from("study_sets").insert({
    id: setId,
    user_id: owner,
    name: study.name,
  });
  raise(setError, "Could not store the study set");

  if (study.questions.length > 0) {
    const { error } = await supabase.from("questions").insert(
      study.questions.map((question) =>
        questionPayload({ ...question, id: questionIds.get(question.id) ?? question.id, setId }, owner),
      ),
    );
    raise(error, "Could not store questions. The new set may be partial");
  }

  const sources = study.sources.flatMap((source) => {
    const questionId = questionIds.get(source.questionId);
    const id = sourceIds.get(source.id);
    if (questionId == null || id == null) return [];
    return [
      {
        id,
        question_id: questionId,
        user_id: owner,
        title: source.title,
        url: source.url,
        published_at: source.publishedAt,
        body: source.body,
      },
    ];
  });
  if (sources.length > 0) {
    const { error } = await supabase.from("sources").insert(sources);
    raise(error, "Could not store sources. The new set may be partial");
  }

  const claims = study.claims.flatMap((claim) => {
    const questionId = questionIds.get(claim.questionId);
    const id = claimIds.get(claim.id);
    if (questionId == null || id == null) return [];
    return [
      {
        id,
        question_id: questionId,
        user_id: owner,
        text: claim.text,
        source_id: claim.sourceId == null ? null : (sourceIds.get(claim.sourceId) ?? null),
      },
    ];
  });
  if (claims.length > 0) {
    const { error } = await supabase.from("claims").insert(claims);
    raise(error, "Could not store claims. The new set may be partial");
  }

  const forecasts = study.forecasts.flatMap((forecast) => {
    const questionId = questionIds.get(forecast.questionId);
    if (questionId == null) return [];
    return [
      {
        id: crypto.randomUUID(),
        question_id: questionId,
        user_id: owner,
        arm: forecast.arm,
        probability: forecast.probability,
        origin: forecast.origin,
        rationale: forecast.rationale,
        model: forecast.model,
        status: forecast.status,
        withhold_reason: forecast.withholdReason,
        claim_ids: forecast.claimIds.flatMap((id) => {
          const next = claimIds.get(id);
          return next == null ? [] : [next];
        }),
      },
    ];
  });
  if (forecasts.length > 0) {
    const { error } = await supabase.from("forecasts").insert(forecasts);
    raise(error, "Could not store forecasts. The new set may be partial");
  }

  return loadSet(setId);
}

export async function renameSet(setId: string, name: string): Promise<void> {
  const supabase = client();
  const { error } = await supabase.from("study_sets").update({ name }).eq("id", setId);
  raise(error, "Could not rename the study set");
}

export async function deleteSet(setId: string): Promise<void> {
  const supabase = client();
  const { error } = await supabase.from("study_sets").delete().eq("id", setId);
  raise(error, "Could not delete the study set");
}

export async function insertQuestion(question: QuestionRecord): Promise<QuestionRecord> {
  const supabase = client();
  const owner = await userId(supabase);
  const { data, error } = await supabase.from("questions").insert(questionPayload(question, owner)).select("*").single();
  raise(error, "Could not store the question");
  return asQuestion(data as QuestionRow);
}

export async function updateQuestion(question: QuestionRecord): Promise<void> {
  const supabase = client();
  const owner = await userId(supabase);
  const { error } = await supabase.from("questions").update(questionPayload(question, owner)).eq("id", question.id);
  raise(error, "Could not update the question");
}

export async function insertSource(source: SourceRecord): Promise<SourceRecord> {
  const supabase = client();
  const owner = await userId(supabase);
  const { data, error } = await supabase
    .from("sources")
    .insert({
      id: source.id,
      question_id: source.questionId,
      user_id: owner,
      title: source.title,
      url: source.url,
      published_at: source.publishedAt,
      body: source.body,
    })
    .select("*")
    .single();
  raise(error, "Could not store the source");
  return asSource(data as SourceRow);
}

export async function deleteSource(sourceId: string): Promise<void> {
  const supabase = client();
  const { error } = await supabase.from("sources").delete().eq("id", sourceId);
  raise(error, "Could not delete the source");
}

export async function insertClaim(claim: ClaimRecord): Promise<ClaimRecord> {
  const supabase = client();
  const owner = await userId(supabase);
  const { data, error } = await supabase
    .from("claims")
    .insert({
      id: claim.id,
      question_id: claim.questionId,
      user_id: owner,
      text: claim.text,
      source_id: claim.sourceId,
    })
    .select("*")
    .single();
  raise(error, "Could not store the claim");
  return asClaim(data as ClaimRow);
}

export async function deleteClaim(claimId: string): Promise<void> {
  const supabase = client();
  const { error } = await supabase.from("claims").delete().eq("id", claimId);
  raise(error, "Could not delete the claim");
}

export async function insertForecast(forecast: ForecastRecord): Promise<ForecastRecord> {
  const supabase = client();
  const owner = await userId(supabase);
  const { data, error } = await supabase
    .from("forecasts")
    .insert({
      id: forecast.id,
      question_id: forecast.questionId,
      user_id: owner,
      arm: forecast.arm,
      probability: forecast.probability,
      origin: forecast.origin,
      rationale: forecast.rationale,
      model: forecast.model,
      status: forecast.status,
      withhold_reason: forecast.withholdReason,
      claim_ids: forecast.claimIds,
    })
    .select("*")
    .single();
  raise(error, "Could not store the forecast");
  return asForecast(data as ForecastRow);
}

export async function listRuns(setId: string): Promise<RunSummary[]> {
  const supabase = client();
  const { data, error } = await supabase
    .from("runs")
    .select("id, label, created_at")
    .eq("set_id", setId)
    .order("created_at", { ascending: false });
  raise(error, "Could not list saved runs");
  return (data ?? []).map((row) => ({
    id: String(row.id),
    label: String(row.label),
    createdAt: String(row.created_at),
  }));
}

export async function insertRun(setId: string, label: string, summary: unknown): Promise<void> {
  const supabase = client();
  const owner = await userId(supabase);
  const { error } = await supabase.from("runs").insert({
    id: crypto.randomUUID(),
    set_id: setId,
    user_id: owner,
    label,
    summary,
  });
  raise(error, "Could not save the scoreboard");
}
