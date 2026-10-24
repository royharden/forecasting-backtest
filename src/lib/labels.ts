import type { GateReason } from "../../supabase/functions/_shared/engine.ts";

export const GATE_LABEL: Record<"kept" | GateReason, string> = {
  kept: "Kept",
  invalid_reference: "Wrong question/version",
  rights_missing: "No rights note",
  blocklisted_source: "Blocklisted source",
  undated: "Undated",
  published_after_cutoff: "Published after cutoff",
  version_unavailable: "Version not proven by cutoff",
  update_marker: "Edited/updated after cutoff",
  duplicate_content: "Duplicate content",
  over_cap: "Over excerpt cap",
};

export const REASON_LABEL: Record<string, string> = {
  valid: "Valid supported output",
  insufficient_evidence: "Skipped: empty strict evidence pack",
  withheld_unsupported_claims: "Withheld: unsupported claim(s)",
  withheld_audit: "Withheld: post-inference audit",
  replay_miss: "Replay miss (no recording)",
  provider_transient: "Provider transient error",
  provider_terminal: "Provider terminal error",
  schema_invalid: "Output schema invalid",
  pending: "Pending",
  ok: "Available",
  missing: "No price at or before cutoff",
  stale: "Price older than 24h",
  ambiguous: "Conflicting same-time prices",
  category: "Category training cohort",
  global: "Global training cohort",
  unavailable: "Unavailable (n < 10)",
};

export function reasonLabel(code: string): string {
  return REASON_LABEL[code] ?? code;
}

export function formatScore(value: number | null | undefined, digits = 3): string {
  if (value == null || Number.isNaN(value)) return "—";
  return value.toFixed(digits);
}

export function formatSigned(value: number | null | undefined, digits = 4): string {
  if (value == null || Number.isNaN(value)) return "—";
  return `${value > 0 ? "+" : ""}${value.toFixed(digits)}`;
}

export function shortHash(hash: string | null | undefined): string {
  return hash == null || hash === "" ? "—" : `${hash.slice(0, 12)}…`;
}

export function messageOf(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== "") return error.message;
  return "Something went wrong.";
}

export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

/** Only http(s) links are rendered as anchors; importer URLs stay inert otherwise. */
export function safeHref(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : null;
  } catch {
    return null;
  }
}
