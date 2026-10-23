import type { ClaimRecord, ForecastRecord, ModelArm } from "../../supabase/functions/_shared/engine.ts";
import { readPublicConfig } from "./config";
import { getSupabase } from "./supabaseClient";

export type LiveForecastResponse = {
  forecast: ForecastRecord;
  claims: ClaimRecord[];
  message: string;
};

export async function requestLiveForecast(questionId: string, arm: ModelArm): Promise<LiveForecastResponse> {
  const config = readPublicConfig();
  const supabase = getSupabase();
  if (config == null || supabase == null) {
    throw new Error("Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY before calling the forecast function.");
  }
  const { data, error } = await supabase.auth.getSession();
  if (error != null) throw new Error(error.message);
  const token = data.session?.access_token;
  if (token == null) throw new Error("Sign in before asking for a live forecast.");

  let response: Response;
  try {
    response = await fetch(`${config.url}/functions/v1/forecast`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: config.anonKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ questionId, arm }),
    });
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : "network error";
    throw new Error(`The forecast function could not be reached (${detail}).`);
  }

  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      payload != null &&
      typeof payload === "object" &&
      "message" in payload &&
      typeof payload.message === "string" &&
      payload.message.trim() !== ""
        ? payload.message
        : `The forecast function returned HTTP ${response.status}. No probability was stored.`;
    throw new Error(message);
  }
  return readLiveForecastResponse(payload);
}

export function readLiveForecastResponse(value: unknown): LiveForecastResponse {
  if (value == null || typeof value !== "object") {
    throw new Error("The forecast function returned an unexpected body. No probability was filled in.");
  }
  const record = value as Record<string, unknown>;
  const forecast = readForecast(record.forecast);
  if (!Array.isArray(record.claims)) {
    throw new Error("The forecast function returned no claim list. No probability was filled in.");
  }
  const claims = record.claims.map(readClaim);
  const message = typeof record.message === "string" && record.message.trim() !== "" ? record.message : "Live forecast stored.";
  return { forecast, claims, message };
}

function readForecast(value: unknown): ForecastRecord {
  if (value == null || typeof value !== "object") {
    throw new Error("The forecast function returned no forecast.");
  }
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string" || typeof row.questionId !== "string") {
    throw new Error("The forecast function returned an incomplete forecast.");
  }
  if (row.arm !== "no_research" && row.arm !== "research") {
    throw new Error("The forecast function returned an unknown arm.");
  }
  if (typeof row.probability !== "number" || !Number.isFinite(row.probability)) {
    throw new Error("The forecast function did not return a numeric probability.");
  }
  if (row.origin !== "live") throw new Error("The forecast function returned a forecast that is not marked live.");
  if (typeof row.rationale !== "string") throw new Error("The forecast function returned no rationale.");
  if (row.status !== "scored" && row.status !== "withheld") {
    throw new Error("The forecast function returned an unknown status.");
  }
  if (!Array.isArray(row.claimIds) || row.claimIds.some((id) => typeof id !== "string")) {
    throw new Error("The forecast function returned an invalid claim list.");
  }
  return {
    id: row.id,
    questionId: row.questionId,
    arm: row.arm,
    probability: row.probability,
    origin: "live",
    rationale: row.rationale,
    model: typeof row.model === "string" ? row.model : null,
    claimIds: row.claimIds as string[],
    status: row.status,
    withholdReason: typeof row.withholdReason === "string" ? row.withholdReason : null,
  };
}

function readClaim(value: unknown): ClaimRecord {
  if (value == null || typeof value !== "object") {
    throw new Error("The forecast function returned a claim that is not an object.");
  }
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string" || typeof row.questionId !== "string" || typeof row.text !== "string") {
    throw new Error("The forecast function returned an incomplete claim.");
  }
  if (row.sourceId != null && typeof row.sourceId !== "string") {
    throw new Error("The forecast function returned a claim with a bad source id.");
  }
  return {
    id: row.id,
    questionId: row.questionId,
    text: row.text,
    sourceId: typeof row.sourceId === "string" ? row.sourceId : null,
  };
}
