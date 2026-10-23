import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import {
  buildForecastPrompt,
  containsResolutionPhrase,
  LIVE_FORECAST_HOURLY_CAP,
  MODEL_ID,
  parseModelPayload,
  questionEligibility,
  reviewClaim,
  selectPromptSources,
  type QuestionRecord,
  type SourceRecord,
} from "../_shared/engine.ts";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type QuestionQueryRow = {
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

type SourceQueryRow = {
  id: string;
  question_id: string;
  title: string;
  url: string;
  published_at: string | null;
  body: string;
};

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (request.method !== "POST") {
    return json(405, { error: "method_not_allowed", message: "Use POST." });
  }

  const authHeader = request.headers.get("Authorization");
  if (authHeader == null || !authHeader.startsWith("Bearer ")) {
    return json(401, { error: "missing_jwt", message: "Sign in before asking for a live forecast." });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (supabaseUrl == null || supabaseUrl.trim() === "" || anonKey == null || anonKey.trim() === "") {
    return json(500, {
      error: "missing_platform_env",
      message: "SUPABASE_URL and SUPABASE_ANON_KEY must be available to the function.",
    });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json(400, { error: "invalid_json", message: "Send a JSON object with questionId and arm." });
  }
  if (body == null || typeof body !== "object") {
    return json(400, { error: "invalid_json", message: "Send a JSON object with questionId and arm." });
  }
  const input = body as Record<string, unknown>;
  const questionId = input.questionId;
  const arm = input.arm;
  if (typeof questionId !== "string" || questionId.trim() === "") {
    return json(400, { error: "invalid_question", message: "questionId is required." });
  }
  if (arm !== "research" && arm !== "no_research") {
    return json(400, { error: "invalid_arm", message: "arm must be research or no_research." });
  }

  const supabase = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError != null || userData.user == null) {
    return json(401, { error: "invalid_jwt", message: "The session is not valid." });
  }
  const owner = userData.user.id;

  const { data: questionRow, error: questionError } = await supabase
    .from("questions")
    .select("id, set_id, prompt, cutoff_at, resolved_at, outcome, market_price, resolution_statement, model_knowledge_cutoff")
    .eq("id", questionId)
    .maybeSingle();
  if (questionError != null) {
    return json(500, { error: "question_read_failed", message: questionError.message });
  }
  if (questionRow == null) {
    return json(404, { error: "question_not_found", message: "That question is not on this account." });
  }

  const question = asQuestion(questionRow as QuestionQueryRow);
  const eligibility = questionEligibility(question);
  if (!eligibility.eligible) {
    return json(422, {
      error: "question_ineligible",
      message: "The cutoff must be before resolution and the YES price must be between 0 and 1.",
    });
  }

  const { data: sourceRows, error: sourceError } = await supabase
    .from("sources")
    .select("id, question_id, title, url, published_at, body")
    .eq("question_id", question.id);
  if (sourceError != null) {
    return json(500, { error: "source_read_failed", message: sourceError.message });
  }
  const sources = ((sourceRows ?? []) as SourceQueryRow[]).map(asSource);
  const promptSources = selectPromptSources(question, sources);
  if (arm === "research" && promptSources.length === 0) {
    return json(422, {
      error: "no_admitted_sources",
      message:
        "Add at least one source published at or before the cutoff whose text does not contain the resolution sentence. The model was not called.",
    });
  }

  const xaiKey = Deno.env.get("XAI_API_KEY");
  if (xaiKey == null || xaiKey.trim() === "") {
    return json(503, {
      error: "missing_secret",
      message: "Set the server secret XAI_API_KEY. The function will not invent a probability.",
    });
  }

  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { count, error: countError } = await supabase
    .from("forecasts")
    .select("id", { count: "exact", head: true })
    .eq("origin", "live")
    .gte("created_at", since);
  if (countError != null) {
    return json(500, { error: "cap_read_failed", message: countError.message });
  }
  if ((count ?? 0) >= LIVE_FORECAST_HOURLY_CAP) {
    return json(429, {
      error: "rate_limited",
      message: `Live forecast cap is ${LIVE_FORECAST_HOURLY_CAP} per hour for this account.`,
    });
  }

  const prompt = buildForecastPrompt(question, sources, arm);
  let completion: Response;
  try {
    completion = await fetch("https://api.x.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${xaiKey}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(50_000),
      body: JSON.stringify({
        model: MODEL_ID,
        stream: false,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: prompt.system },
          { role: "user", content: prompt.user },
        ],
      }),
    });
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : "request failed";
    return json(502, {
      error: "model_unreachable",
      message: `The model request failed (${detail}). No probability was stored.`,
    });
  }

  if (!completion.ok) {
    const detail = (await completion.text()).slice(0, 500);
    return json(502, {
      error: "model_rejected",
      message: `The model returned HTTP ${completion.status}. No probability was stored. ${detail}`,
    });
  }

  let completionBody: unknown;
  try {
    completionBody = await completion.json();
  } catch {
    return json(502, { error: "model_unreadable", message: "The model response was not JSON. No probability was stored." });
  }
  const content = readContent(completionBody);
  if (content == null) {
    return json(502, { error: "model_empty", message: "The model returned no text. No probability was stored." });
  }
  const parsed = parseModelPayload(content);
  if (parsed == null) {
    return json(502, {
      error: "model_unparsed",
      message: "The model did not return a probability from 0 to 1 with a rationale and a claims array. Nothing was stored.",
    });
  }

  const allowed = new Set(promptSources.map((source) => source.id));
  const claimInserts = arm === "research"
    ? parsed.claims.flatMap((claim) => {
        const text = claim.text.trim();
        if (text === "" || !allowed.has(claim.sourceId)) return [];
        return [
          {
            id: crypto.randomUUID(),
            question_id: question.id,
            user_id: owner,
            text,
            source_id: claim.sourceId,
          },
        ];
      })
    : [];

  const admittedIds = claimInserts
    .filter((row) =>
      reviewClaim(question, promptSources, {
        id: row.id,
        questionId: question.id,
        text: row.text,
        sourceId: row.source_id,
      }).admitted,
    )
    .map((row) => row.id);

  let status: "scored" | "withheld" = "scored";
  let withholdReason: string | null = null;
  if (containsResolutionPhrase(parsed.rationale, question.resolutionStatement)) {
    status = "withheld";
    withholdReason = "Rationale contains the resolution sentence.";
  } else if (arm === "research" && admittedIds.length === 0) {
    status = "withheld";
    withholdReason = "No admitted claim. The probability is kept and not scored.";
  }

  const storedClaims = claimInserts.filter((row) => admittedIds.includes(row.id));
  if (storedClaims.length > 0) {
    const { error: claimError } = await supabase.from("claims").insert(storedClaims);
    if (claimError != null) {
      return json(500, { error: "claim_write_failed", message: `${claimError.message} No forecast was stored.` });
    }
  }

  const forecastId = crypto.randomUUID();
  const forecastInsert = {
    id: forecastId,
    question_id: question.id,
    user_id: owner,
    arm,
    probability: parsed.probability,
    origin: "live",
    rationale: parsed.rationale,
    model: MODEL_ID,
    status,
    withhold_reason: withholdReason,
    claim_ids: admittedIds,
  };
  const { error: forecastError } = await supabase.from("forecasts").insert(forecastInsert);
  if (forecastError != null) {
    return json(500, {
      error: "forecast_write_failed",
      message: `${forecastError.message} Claims may already have been stored.`,
    });
  }

  return json(200, {
    forecast: {
      id: forecastId,
      questionId: question.id,
      arm,
      probability: parsed.probability,
      origin: "live",
      rationale: parsed.rationale,
      model: MODEL_ID,
      claimIds: admittedIds,
      status,
      withholdReason,
    },
    claims: storedClaims.map((row) => ({
        id: row.id,
        questionId: question.id,
        text: row.text,
        sourceId: row.source_id,
      })),
    message: status === "scored" ? "Live forecast stored." : `Stored and withheld: ${withholdReason}`,
  });
});

function asQuestion(row: QuestionQueryRow): QuestionRecord {
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

function asSource(row: SourceQueryRow): SourceRecord {
  return {
    id: row.id,
    questionId: row.question_id,
    title: row.title,
    url: row.url,
    publishedAt: row.published_at,
    body: row.body,
  };
}

function readContent(value: unknown): string | null {
  if (value == null || typeof value !== "object") return null;
  const choices = (value as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0];
  if (first == null || typeof first !== "object") return null;
  const message = (first as { message?: unknown }).message;
  if (message == null || typeof message !== "object") return null;
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string" && content.trim() !== "") return content;
  if (!Array.isArray(content)) return null;
  const text = content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part != null && typeof part === "object" && "text" in part && typeof part.text === "string") return part.text;
      return "";
    })
    .join("")
    .trim();
  return text === "" ? null : text;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
