/**
 * Offline, no-secrets manifest normalizer and validator (PLAN.md s.1 "Real-data path").
 *
 *   node --experimental-strip-types scripts/prepare-manifest.ts <prepare-input.json> <manifest-out.json>
 *
 * Input: owner-obtained venue records, price observations and archived evidence snippets in the
 * loose shape documented in README ("Real-data worked manifest"). Output: manifest v1 plus a
 * diagnostics report on stderr. It never accesses a network, API or credential, never invents
 * historical wording, prices, dates or outcomes, and leaves missing evidence excluded.
 * Written under Dirty Mode; not executed yet.
 */

import { readFileSync, writeFileSync } from "node:fs";
import {
  BLOCKLIST_VERSION,
  FALLBACK_POLICY,
  GATE_VERSION,
  importManifest,
  isoUtc,
  marketAsOf,
  parseUtc,
  PROMPT_VERSION,
} from "../supabase/functions/_shared/engine.ts";

type Raw = Record<string, unknown>;
type Diagnostic = { level: "reject" | "warn"; where: string; message: string };

const diagnostics: Diagnostic[] = [];
const reject = (where: string, message: string) => diagnostics.push({ level: "reject", where, message });
const warn = (where: string, message: string) => diagnostics.push({ level: "warn", where, message });

function text(row: Raw, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return null;
}

/**
 * Normalize a timestamp to explicit UTC. Accepts ISO 8601 with Z or a numeric offset (converted),
 * or epoch seconds/milliseconds. Timezone-free strings are rejected, never assumed to be UTC.
 */
function utc(value: unknown, where: string, field: string): string | null {
  if (value == null || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value > 1e12 ? value : value * 1000;
    return isoUtc(ms);
  }
  if (typeof value !== "string") {
    reject(where, `${field} is not a timestamp.`);
    return null;
  }
  if (parseUtc(value) != null) return value;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?[+-]\d{2}:\d{2}$/.test(value)) {
    const ms = Date.parse(value);
    if (!Number.isNaN(ms)) return isoUtc(ms);
  }
  reject(where, `${field} "${value}" has no explicit timezone or is invalid; it was not guessed.`);
  return null;
}

function outcome(value: unknown): number | null {
  if (value === 1 || value === true || value === "YES" || value === "Yes" || value === "yes") return 1;
  if (value === 0 || value === false || value === "NO" || value === "No" || value === "no") return 0;
  return null;
}

function probability(row: Raw, where: string): number | null {
  const raw = row.yes_probability ?? row.yesProbability ?? row.price ?? row.p;
  const unit = row.unit;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    reject(where, "No numeric YES price.");
    return null;
  }
  const value = unit === "cents" ? raw / 100 : raw;
  if (value < 0 || value > 1) {
    reject(where, `YES price ${raw} is outside [0, 1] (set unit "cents" for 0..100 prices).`);
    return null;
  }
  return value;
}

function main(): void {
  const [input, output] = process.argv.slice(2);
  if (input == null || output == null) {
    console.error("usage: node --experimental-strip-types scripts/prepare-manifest.ts <prepare-input.json> <manifest-out.json>");
    process.exit(2);
  }
  const source = JSON.parse(readFileSync(input, "utf8")) as Raw;
  const dataset = (source.dataset ?? {}) as Raw;
  const kind = dataset.kind === "synthetic" ? "synthetic" : "real";

  const questions = ((source.questions ?? []) as Raw[]).flatMap((row, i) => {
    const where = `questions[${i}]`;
    const id = text(row, "id", "question_id");
    const wording = text(row, "question_text_as_of", "title_as_of", "questionTextAsOf");
    const rules = text(row, "resolution_rules_as_of", "rules_as_of", "resolutionRulesAsOf");
    if (id == null) {
      reject(where, "Missing id.");
      return [];
    }
    if (wording == null || rules == null) {
      reject(where, "Missing historical (as-of) wording or rules. Current text scraped after resolution is not an as-of record; nothing was substituted.");
      return [];
    }
    const category = text(row, "category");
    const cluster = text(row, "event_cluster_id", "cluster", "eventClusterId");
    if (category == null || cluster == null) {
      reject(where, "Missing category or event cluster; they decide base-rate cohorts and cluster independence, so nothing was assumed.");
      return [];
    }
    const proof = text(row, "wording_version_proof", "wording_proof") ?? "";
    if (kind === "real" && proof === "") warn(where, "No wording version proof: the question will be quarantined as wording_unproven.");
    const resolved = outcome(row.outcome);
    if (resolved == null) warn(where, `Outcome ${JSON.stringify(row.outcome)} is not YES/NO: kept raw and quarantined as outcome_not_binary.`);
    return [
      {
        id,
        role: row.role === "training" ? "training" : "evaluation",
        category,
        eventClusterId: cluster,
        questionTextAsOf: wording,
        resolutionRulesAsOf: rules,
        opensAt: utc(row.opens_at ?? row.opened_at ?? row.opensAt, where, "opens_at"),
        wordingAvailableAt: utc(row.wording_available_at ?? row.wording_captured_at ?? row.wordingAvailableAt, where, "wording_available_at"),
        wordingVersionProof: proof,
        cutoffAt: utc(row.cutoff_at ?? row.cutoffAt, where, "cutoff_at"),
        scheduledCloseAt: utc(row.scheduled_close_at ?? row.scheduledCloseAt, where, "scheduled_close_at"),
        scheduledCloseProvenance: text(row, "scheduled_close_source", "scheduledCloseProvenance"),
        actualCloseAt: utc(row.closed_at ?? row.actual_close_at ?? row.actualCloseAt, where, "closed_at"),
        resolvedAt: utc(row.resolved_at ?? row.resolvedAt, where, "resolved_at"),
        outcome: resolved ?? (typeof row.outcome === "number" ? row.outcome : null),
        resolutionAuditText: text(row, "resolution_audit_text", "resolution_note") ?? "",
      },
    ];
  });

  const evidence = ((source.evidence ?? []) as Raw[]).flatMap((row, i) => {
    const where = `evidence[${i}]`;
    const excerpt = text(row, "excerpt", "text", "snippet");
    const id = text(row, "id");
    const questionId = text(row, "question_id", "questionId");
    const retrievedAt = utc(row.retrieved_at ?? row.retrievedAt, where, "retrieved_at");
    if (excerpt == null || id == null || questionId == null || retrievedAt == null) {
      reject(where, "Missing id, question_id, excerpt text or retrieved_at; nothing was fetched or filled in.");
      return [];
    }
    const at = utc(row.published_at ?? row.publishedAt, where, "published_at");
    const date = text(row, "published_date");
    const published = at != null ? { precision: "instant", at } : date != null ? { precision: "day", date } : { precision: "unknown" };
    if (published.precision === "unknown") warn(where, "No publication time: the gate will exclude it as undated.");
    const versionAt = utc(row.version_available_at ?? row.archived_at, where, "archived_at");
    if (versionAt == null) warn(where, "No archive/version time: the gate will exclude it as version_unavailable.");
    return [
      {
        id,
        questionId,
        title: text(row, "title") ?? id,
        url: text(row, "url") ?? "",
        published,
        retrievedAt,
        versionAvailableAt: versionAt,
        versionProof: text(row, "version_proof", "archive_id"),
        updatedAt: utc(row.updated_at ?? row.updatedAt, where, "updated_at"),
        excerpt,
        rightsNote: text(row, "rights_note", "licence", "license") ?? "",
      },
    ];
  });

  const marketObservations = ((source.prices ?? []) as Raw[]).flatMap((row, i) => {
    const where = `prices[${i}]`;
    const questionId = text(row, "question_id", "questionId");
    const observedAt = utc(row.observed_at ?? row.timestamp ?? row.observedAt, where, "observed_at");
    const p = probability(row, where);
    const venue = text(row, "venue");
    const provenance = text(row, "provenance", "source");
    if (venue == null || provenance == null) reject(where, "Missing venue or provenance for this price; no provenance was assumed.");
    if (questionId == null) reject(where, "Missing question_id for this price.");
    if (observedAt == null && (row.observed_at ?? row.timestamp ?? row.observedAt) == null) reject(where, "Missing observed_at for this price.");
    if (questionId == null || observedAt == null || p == null || venue == null || provenance == null) return [];
    return [
      {
        id: text(row, "id") ?? `${questionId}-price-${i}`,
        questionId,
        yesProbability: p,
        observedAt,
        venue,
        provenance,
      },
    ];
  });

  const manifest = {
    schemaVersion: 1,
    datasetId: text(dataset, "datasetId", "id") ?? "prepared-dataset",
    name: text(dataset, "name") ?? "Prepared dataset",
    kind,
    provenance: text(dataset, "provenance") ?? "",
    rights: text(dataset, "rights") ?? "",
    protocol: {
      protocolId: text(dataset, "protocolId") ?? "prepared-protocol-v1",
      cutoffPreset: dataset.cutoffPreset === "scheduled-midpoint-v1" ? "scheduled-midpoint-v1" : "supplied-fixed-v1",
      cutoffSelectionNote: text(dataset, "cutoffSelectionNote") ?? "Cutoffs frozen together before scoring; retrospectively selected.",
      fallbackPolicy: FALLBACK_POLICY,
      sourceBufferHours: kind === "synthetic" ? 0 : 24,
      maxPriceAgeHours: 24,
      trainMinimum: 10,
      calibrationBins: questions.length >= 50 ? 10 : 5,
      maxPromptExcerpts: 8,
      eligibilityNote: text(dataset, "eligibilityNote") ?? "Resolved binary questions with historical wording proof.",
      modelProfileVersion: text(dataset, "modelProfileVersion") ?? "recorded",
      promptVersion: PROMPT_VERSION,
      gateVersion: GATE_VERSION,
      blocklistVersion: BLOCKLIST_VERSION,
      bootstrapSeed: 14,
      bootstrapReplicates: 2000,
    },
    questions,
    evidence,
    marketObservations,
    recordedAttempts: source.recordedAttempts ?? [],
  };

  const result = importManifest(manifest, isoUtc(Date.now()));
  if (!result.ok) {
    for (const issue of result.errors) reject(issue.path, `${issue.code}: ${issue.message}`);
  } else {
    for (const row of result.version.quarantine) warn(`question ${row.targetId}`, `quarantined: ${row.reason} — ${row.detail}`);
    // Last-observation selection preview: the same rule the scorer uses, shown before any scoring.
    for (const q of result.version.questions.filter((item) => item.role === "evaluation" && item.cutoffAt != null)) {
      const market = marketAsOf(result.version.marketObservations.filter((o) => o.questionId === q.id), q.cutoffAt as string, 24);
      if (market.status !== "ok") warn(`question ${q.id}`, `market price ${market.status}: ${market.detail}`);
    }
  }

  writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const rejects = diagnostics.filter((d) => d.level === "reject").length;
  for (const d of diagnostics) console.error(`${d.level.toUpperCase()} ${d.where}: ${d.message}`);
  console.error(`${result.ok ? "VALID" : "INVALID"} manifest written to ${output}: ${questions.length} question(s), ${evidence.length} evidence row(s), ${marketObservations.length} price(s), ${rejects} rejected row(s).`);
  process.exit(result.ok ? 0 : 1);
}

main();
