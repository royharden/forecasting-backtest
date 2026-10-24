/**
 * Deterministic, outcome-independent pre-send evidence gate and the frozen PromptEvidence array
 * (PLAN.md s.2 and s.4 "Exact workflow").
 *
 * Inputs are the as-of question fields (id, cutoffAt, evidenceCutoff), the protocol card and the
 * candidate evidence rows. Outcomes, resolution audit text, prices and human verdicts are not
 * parameters, so they cannot choose, order, truncate or modify what the model and critic see.
 */

import { hashCanonical, sha256Hex } from "./canonical.ts";
import { BLOCKLIST_VERSION, GATE_VERSION, type ManifestEvidence, type ProtocolCard } from "./manifest.ts";
import { describePublished, isoUtc, parseUtc, publishedBounds } from "./time.ts";

/**
 * First-failure order (gate-1). A candidate gets exactly one of these, or "kept". gate-1 inserts
 * rights_missing after the reference check; otherwise it follows PLAN.md s.4 exactly.
 */
export const GATE_REASONS = [
  "invalid_reference",
  "rights_missing",
  "blocklisted_source",
  "undated",
  "published_after_cutoff",
  "version_unavailable",
  "update_marker",
  "duplicate_content",
  "over_cap",
] as const;
export type GateReason = (typeof GATE_REASONS)[number];

export type SourceDecision = {
  evidenceId: string;
  questionId: string;
  decision: "kept" | GateReason;
  detail: string;
  /** Additional warnings. Never counted as drops. */
  warnings: string[];
  availableAt: string | null;
};

export type PromptEvidence = {
  evidenceId: string;
  questionId: string;
  title: string;
  published: string;
  availableAt: string;
  /** Excerpt after the code-point cap. Claim offsets are UTF-16 indices into this string. */
  excerpt: string;
  excerptHash: string;
  /** SHA-256 of the full imported excerpt. */
  contentHash: string;
  truncated: boolean;
};

export type QuestionFunnel = {
  questionId: string;
  raw: number;
  kept: number;
  drops: Record<GateReason, number>;
  warnings: number;
};

export type GateQuestion = { id: string; cutoffAt: string; evidenceCutoff: string };

export type GateResult = {
  questionId: string;
  ledger: SourceDecision[];
  promptEvidence: PromptEvidence[];
  promptEvidenceHash: string;
  funnel: QuestionFunnel;
  gateVersion: string;
  blocklistVersion: string;
};

/** Versioned blocklist (blocklist-1): market/crowd-forecast venues, resolution summaries and Wikipedia. */
export const BLOCKED_DOMAINS: readonly string[] = [
  "polymarket.com",
  "kalshi.com",
  "manifold.markets",
  "metaculus.com",
  "predictit.org",
  "gjopen.com",
  "goodjudgment.com",
  "insightprediction.com",
  "smarkets.com",
  "betfair.com",
  "oddschecker.com",
  "augur.net",
  "hypermind.com",
  "wikipedia.org",
];

/** Frozen content rules for crowd-forecast pages and retrospective resolution summaries. */
export const BLOCKED_CONTENT_PATTERNS: readonly RegExp[] = [
  /\bmarket (?:has )?resolved\b/i,
  /\bresolved (?:to )?(?:yes|no)\b/i,
  /\bresolution (?:summary|outcome)\b/i,
  /\bcommunity (?:prediction|forecast)\b/i,
  /\bcrowd forecast\b/i,
  /\bprediction market odds\b/i,
];

/** Limited update-marker heuristic. A marker with no dated update time is undecidable and excluded. */
const UPDATE_MARKER = /\b(?:updated|last update|editor'?s note|this (?:article|story) has been (?:updated|corrected))\b|\bcorrection:/i;

/** Parsed hostname boundary match; never a substring match. */
export function isBlockedHost(url: string): boolean {
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return false;
  }
  return BLOCKED_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

export function matchesBlockedContent(title: string, excerpt: string): boolean {
  const text = `${title}\n${excerpt}`;
  return BLOCKED_CONTENT_PATTERNS.some((pattern) => pattern.test(text));
}

/** Truncate to a code-point count without splitting a surrogate pair. */
export function truncateCodePoints(text: string, max: number): { text: string; truncated: boolean } {
  const points = Array.from(text);
  if (points.length <= max) return { text, truncated: false };
  return { text: points.slice(0, max).join(""), truncated: true };
}

function emptyDrops(): Record<GateReason, number> {
  return Object.fromEntries(GATE_REASONS.map((reason) => [reason, 0])) as Record<GateReason, number>;
}

type Candidate = { row: ManifestEvidence; availableMs: number | null; warnings: string[] };

/**
 * Run the gate for one question. Candidates are deduplicated and capped after a stable sort by
 * availability time then evidence ID. The ledger keeps one decision per raw candidate.
 */
export function gateEvidence(
  question: GateQuestion,
  candidates: readonly ManifestEvidence[],
  protocol: Pick<ProtocolCard, "maxPromptExcerpts" | "sourceBufferHours">,
  excerptCodePoints = 2000,
): GateResult {
  const evidenceCutoff = parseUtc(question.evidenceCutoff);
  const decisions = new Map<string, SourceDecision>();
  const survivors: Candidate[] = [];

  for (const row of candidates) {
    const warnings: string[] = [];
    const decide = (decision: GateReason, detail: string, availableAt: string | null = null) =>
      decisions.set(row.id, { evidenceId: row.id, questionId: row.questionId, decision, detail, warnings, availableAt });

    if (row.questionId !== question.id || evidenceCutoff == null) {
      decide("invalid_reference", "Evidence is not attached to this question/version.");
      continue;
    }
    if (row.rightsNote.trim() === "") {
      decide("rights_missing", "No rights note for this excerpt.");
      continue;
    }
    if (isBlockedHost(row.url) || matchesBlockedContent(row.title, row.excerpt)) {
      decide("blocklisted_source", `Market/crowd-forecast, resolution-summary or encyclopedia source (${BLOCKLIST_VERSION}).`);
      continue;
    }
    const bounds = publishedBounds(row.published);
    if (bounds == null) {
      decide("undated", "No valid UTC original publication time.");
      continue;
    }
    if (bounds.latest > evidenceCutoff) {
      decide(
        "published_after_cutoff",
        `Latest possible publication (${isoUtc(bounds.latest)}; ${describePublished(row.published)}) is after the evidence cutoff ${question.evidenceCutoff}.`,
      );
      continue;
    }
    const version = parseUtc(row.versionAvailableAt);
    if (version == null || version > evidenceCutoff || row.versionProof == null || row.versionProof.trim() === "") {
      decide("version_unavailable", "No proof that this captured version existed by the evidence cutoff.");
      continue;
    }
    const updated = parseUtc(row.updatedAt);
    if (updated != null && updated > evidenceCutoff) {
      decide("update_marker", "The captured version was edited after the evidence cutoff.");
      continue;
    }
    if (updated == null && UPDATE_MARKER.test(row.excerpt)) {
      decide("update_marker", "The excerpt shows an update/correction marker with no dated update time; historical validity is undecidable.");
      continue;
    }
    if (bounds.earliest !== bounds.latest) warnings.push("publication_time_interval");
    survivors.push({ row, availableMs: Math.max(bounds.latest, version), warnings });
  }

  survivors.sort((a, b) => (a.availableMs as number) - (b.availableMs as number) || compareIds(a.row.id, b.row.id));

  const seenHashes = new Set<string>();
  const promptEvidence: PromptEvidence[] = [];
  for (const candidate of survivors) {
    const { row, warnings } = candidate;
    const availableAt = isoUtc(candidate.availableMs as number);
    if (seenHashes.has(row.contentHash)) {
      decisions.set(row.id, { evidenceId: row.id, questionId: row.questionId, decision: "duplicate_content", detail: "Same content hash as an earlier kept source.", warnings, availableAt });
      continue;
    }
    seenHashes.add(row.contentHash);
    if (promptEvidence.length >= protocol.maxPromptExcerpts) {
      decisions.set(row.id, { evidenceId: row.id, questionId: row.questionId, decision: "over_cap", detail: `Only ${protocol.maxPromptExcerpts} excerpts per question.`, warnings, availableAt });
      continue;
    }
    const cut = truncateCodePoints(row.excerpt, excerptCodePoints);
    if (cut.truncated) warnings.push("excerpt_truncated");
    promptEvidence.push({
      evidenceId: row.id,
      questionId: row.questionId,
      title: row.title,
      published: describePublished(row.published),
      availableAt,
      excerpt: cut.text,
      excerptHash: sha256Hex(cut.text),
      contentHash: row.contentHash,
      truncated: cut.truncated,
    });
    decisions.set(row.id, { evidenceId: row.id, questionId: row.questionId, decision: "kept", detail: "Admitted to the prompt evidence pack.", warnings, availableAt });
  }

  const ledger = candidates.map((row) => decisions.get(row.id) as SourceDecision);
  const drops = emptyDrops();
  let kept = 0;
  let warningCount = 0;
  for (const decision of ledger) {
    if (decision.decision === "kept") kept += 1;
    else drops[decision.decision] += 1;
    warningCount += decision.warnings.length;
  }
  return {
    questionId: question.id,
    ledger,
    promptEvidence,
    promptEvidenceHash: hashCanonical(promptEvidence),
    funnel: { questionId: question.id, raw: candidates.length, kept, drops, warnings: warningCount },
    gateVersion: GATE_VERSION,
    blocklistVersion: BLOCKLIST_VERSION,
  };
}

/** The funnel must balance: kept plus every first-failure drop equals the raw candidates. */
export function funnelBalances(funnel: QuestionFunnel): boolean {
  const dropped = GATE_REASONS.reduce((sum, reason) => sum + funnel.drops[reason], 0);
  return dropped + funnel.kept === funnel.raw;
}

export function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
