/**
 * Harbor synthetic demo as a manifest v1 (PLAN.md s.1 "Single no-cost demo").
 *
 * Every place, date and probability here is fictional. Recorded attempts have origin "demo": they
 * are hand-written outputs that exercise the gate, critic, correction, audit and policy rules.
 * They are not model output and say nothing about real model performance.
 */

import {
  BLOCKLIST_VERSION,
  FALLBACK_POLICY,
  GATE_VERSION,
  PROMPT_VERSION,
  sha256Hex,
  type Manifest,
  type ManifestEvidence,
  type ManifestQuestion,
  type MarketObservation,
  type ModelClaim,
  type RecordedAttempt,
} from "../../supabase/functions/_shared/engine.ts";

const FICTIONAL = "synthetic: fictional record, no real-world capture";
const RIGHTS = "First-party synthetic text, MIT licensed with this repository.";
const RECORDER = { provider: "synthetic", modelId: "harbor-recorder", note: "Hand-written demo output, not a model." };

function evaluation(
  id: string,
  category: string,
  eventClusterId: string,
  text: string,
  opensAt: string,
  cutoffAt: string,
  resolvedAt: string,
  outcome: 0 | 1,
  resolutionAuditText: string,
): ManifestQuestion {
  return {
    id,
    role: "evaluation",
    category,
    eventClusterId,
    questionTextAsOf: text,
    resolutionRulesAsOf: "Resolves YES if the named event happens by the stated date under the fictional operator's public notice; otherwise NO.",
    opensAt,
    wordingAvailableAt: opensAt,
    wordingVersionProof: FICTIONAL,
    suppliedCutoffAt: cutoffAt,
    scheduledCloseAt: null,
    scheduledCloseProvenance: null,
    actualCloseAt: null,
    resolvedAt,
    outcome,
    resolutionAuditText,
  };
}

function training(id: string, category: string, eventClusterId: string, text: string, opensAt: string, resolvedAt: string, outcome: 0 | 1): ManifestQuestion {
  return {
    id,
    role: "training",
    category,
    eventClusterId,
    questionTextAsOf: text,
    resolutionRulesAsOf: "Fictional training item; only its category, cluster, resolution time and outcome are used.",
    opensAt,
    wordingAvailableAt: opensAt,
    wordingVersionProof: FICTIONAL,
    suppliedCutoffAt: null,
    scheduledCloseAt: null,
    scheduledCloseProvenance: null,
    actualCloseAt: null,
    resolvedAt,
    outcome,
    resolutionAuditText: "",
  };
}

type EvidenceSeed = Omit<ManifestEvidence, "contentHash" | "retrievedAt" | "rightsNote" | "versionProof" | "updatedAt"> & {
  versionProof?: string | null;
  updatedAt?: string | null;
};

function evidence(seed: EvidenceSeed): ManifestEvidence {
  return {
    retrievedAt: "2026-10-23T00:00:00.000Z",
    rightsNote: RIGHTS,
    versionProof: seed.versionAvailableAt == null ? null : FICTIONAL,
    updatedAt: null,
    ...seed,
    contentHash: sha256Hex(seed.excerpt),
  };
}

const EVIDENCE: ManifestEvidence[] = [
  evidence({
    id: "e1",
    questionId: "q1",
    title: "May works notice",
    url: "https://example.invalid/northglass/may",
    published: { precision: "instant", at: "2024-05-20T09:00:00.000Z" },
    versionAvailableAt: "2024-05-20T09:00:00.000Z",
    excerpt: "The city clerk said the piers were finished in May and the deck work was still on the published schedule.",
  }),
  evidence({
    id: "e1b",
    questionId: "q1",
    title: "Northglass Bridge (encyclopedia article)",
    url: "https://en.wikipedia.org/wiki/Northglass_Bridge",
    published: { precision: "instant", at: "2024-05-01T00:00:00.000Z" },
    versionAvailableAt: "2024-05-01T00:00:00.000Z",
    excerpt: "Northglass Bridge is a fictional river crossing.",
  }),
  evidence({
    id: "e2",
    questionId: "q2",
    title: "November port notice",
    url: "https://example.invalid/harbor/november",
    published: { precision: "instant", at: "2024-11-18T08:00:00.000Z" },
    versionAvailableAt: "2024-11-18T08:00:00.000Z",
    excerpt: "The port notice for November keeps the Saturday ferry off the board.",
  }),
  evidence({
    id: "e2b",
    questionId: "q2",
    title: "Harbor Line ferry odds",
    url: "https://polymarket.com/event/harbor-line-saturday-ferry",
    published: { precision: "instant", at: "2024-11-20T00:00:00.000Z" },
    versionAvailableAt: "2024-11-20T00:00:00.000Z",
    excerpt: "Traders put the Saturday ferry return at 22 percent.",
  }),
  evidence({
    id: "e3",
    questionId: "q3",
    title: "July board minutes",
    url: "https://example.invalid/ash-court/july",
    published: { precision: "instant", at: "2024-07-12T17:00:00.000Z" },
    versionAvailableAt: "2024-07-12T17:00:00.000Z",
    excerpt: "The museum board minutes from July still call the wing a construction site.",
  }),
  evidence({
    id: "e3b",
    questionId: "q3",
    title: "Opening-week preview (date only)",
    url: "https://example.invalid/ash-court/preview",
    published: { precision: "day", date: "2024-08-01" },
    versionAvailableAt: "2024-08-01T12:00:00.000Z",
    excerpt: "A preview piece dated 1 August describes the gallery layout.",
  }),
  evidence({
    id: "e3c",
    questionId: "q3",
    title: "July board minutes (syndicated copy)",
    url: "https://example.invalid/wire/ash-court-july",
    published: { precision: "instant", at: "2024-07-13T06:00:00.000Z" },
    versionAvailableAt: "2024-07-13T06:00:00.000Z",
    excerpt: "The museum board minutes from July still call the wing a construction site.",
  }),
  evidence({
    id: "e4a",
    questionId: "q4",
    title: "August packing notes",
    url: "https://example.invalid/orchard/august",
    published: { precision: "instant", at: "2024-08-16T10:00:00.000Z" },
    versionAvailableAt: "2024-08-16T10:00:00.000Z",
    excerpt: "August packing notes show a short crop and no booked cold storage.",
  }),
  evidence({
    id: "e4b",
    questionId: "q4",
    title: "Undated forum post",
    url: "https://example.invalid/orchard/forum",
    published: { precision: "unknown" },
    versionAvailableAt: null,
    excerpt: "A forum post claims the pears shipped early.",
  }),
  evidence({
    id: "e4c",
    questionId: "q4",
    title: "Co-op newsletter",
    url: "https://example.invalid/orchard/newsletter",
    published: { precision: "instant", at: "2024-08-20T07:00:00.000Z" },
    versionAvailableAt: "2024-08-20T07:00:00.000Z",
    excerpt: "Updated: the co-op says winter pear shipping plans are under review.",
  }),
  evidence({
    id: "e5",
    questionId: "q5",
    title: "June aftermath wire",
    url: "https://example.invalid/ashpier/june",
    published: { precision: "instant", at: "2025-06-03T06:00:00.000Z" },
    versionAvailableAt: "2025-06-03T06:00:00.000Z",
    excerpt: "The Ashpier lens was relit on 2 June 2025. Crowds were on the point that evening.",
  }),
  evidence({
    id: "e6",
    questionId: "q6",
    title: "June staffing sheet",
    url: "https://example.invalid/pier4/june",
    published: { precision: "instant", at: "2024-06-18T12:00:00.000Z" },
    versionAvailableAt: "2024-06-18T12:00:00.000Z",
    excerpt: "The June staffing sheet lists the booth as weekend only.",
  }),
  evidence({
    id: "e6b",
    questionId: "q6",
    title: "Spring planning memo",
    url: "https://example.invalid/pier4/spring-plan",
    published: { precision: "instant", at: "2024-04-15T15:00:00.000Z" },
    versionAvailableAt: "2024-04-15T15:00:00.000Z",
    excerpt: "The census office plans to keep the Pier 4 booth open until 1 October, staffing permitting.",
  }),
  evidence({
    id: "e6c",
    questionId: "q6",
    title: "Archived council page (later capture only)",
    url: "https://example.invalid/pier4/council",
    published: { precision: "instant", at: "2024-06-25T09:00:00.000Z" },
    versionAvailableAt: null,
    excerpt: "Council notes on booth staffing for the summer season.",
  }),
];

const OBSERVATIONS: MarketObservation[] = [
  { id: "m1a", questionId: "q1", yesProbability: 0.7, observedAt: "2024-05-31T12:00:00.000Z", venue: "Harbor Exchange (fictional)", provenance: FICTIONAL },
  { id: "m1b", questionId: "q1", yesProbability: 0.72, observedAt: "2024-05-31T23:00:00.000Z", venue: "Harbor Exchange (fictional)", provenance: FICTIONAL },
  { id: "m1c", questionId: "q1", yesProbability: 0.8, observedAt: "2024-06-02T00:00:00.000Z", venue: "Harbor Exchange (fictional)", provenance: `${FICTIONAL}; after cutoff, never used` },
  { id: "m2a", questionId: "q2", yesProbability: 0.22, observedAt: "2024-11-30T20:00:00.000Z", venue: "Harbor Exchange (fictional)", provenance: FICTIONAL },
  { id: "m3a", questionId: "q3", yesProbability: 0.4, observedAt: "2024-07-31T18:00:00.000Z", venue: "Harbor Exchange (fictional)", provenance: FICTIONAL },
  { id: "m4a", questionId: "q4", yesProbability: 0.3, observedAt: "2024-08-31T22:00:00.000Z", venue: "Harbor Exchange (fictional)", provenance: FICTIONAL },
  { id: "m4b", questionId: "q4", yesProbability: 0.34, observedAt: "2024-08-31T22:00:00.000Z", venue: "Pier Board (fictional)", provenance: `${FICTIONAL}; conflicts with m4a at the same time` },
  { id: "m5a", questionId: "q5", yesProbability: 0.81, observedAt: "2024-12-31T21:00:00.000Z", venue: "Harbor Exchange (fictional)", provenance: FICTIONAL },
  { id: "m6a", questionId: "q6", yesProbability: 0.15, observedAt: "2024-06-28T12:00:00.000Z", venue: "Harbor Exchange (fictional)", provenance: `${FICTIONAL}; 60h old at the cutoff` },
];

function byId(id: string): ManifestEvidence {
  const row = EVIDENCE.find((e) => e.id === id);
  if (row == null) throw new Error(`Harbor fixture has no evidence ${id}.`);
  return row;
}

/** An exact extractive claim: offsets are UTF-16 indices of `text` inside the excerpt. */
function span(evidenceId: string, text: string): ModelClaim {
  const row = byId(evidenceId);
  const start = row.excerpt.indexOf(text);
  if (start < 0) throw new Error(`Harbor fixture span "${text}" is not in ${evidenceId}.`);
  return { text, evidenceId, start, end: start + text.length, contentHash: sha256Hex(row.excerpt) };
}

function output(probability: number, rationale: string, claims: ModelClaim[] = []): { kind: "text"; text: string } {
  return { kind: "text", text: JSON.stringify({ probability, rationale, claims }) };
}

function recorded(id: string, questionId: string, arm: "no_research" | "research", sequence: 1 | 2, out: RecordedAttempt["output"]): RecordedAttempt {
  return { id, questionId, arm, origin: "demo", sequence, output: out, model: RECORDER };
}

const ATTEMPTS: RecordedAttempt[] = [
  recorded("a1n", "q1", "no_research", 1, output(0.55, "Civic bridges often slip, so this is only a modest yes.")),
  recorded("a1r", "q1", "research", 1, output(0.7, "The May notice keeps the deck on schedule.", [span("e1", "the deck work was still on the published schedule")])),
  recorded("a2n", "q2", "no_research", 1, output(0.48, "There is no strong reason from the question text alone.")),
  // Repeats the offline resolution sentence: withheld by the post-inference audit, no correction.
  recorded(
    "a2r",
    "q2",
    "research",
    1,
    output(0.61, "Harbor Line did not resume the Saturday ferry. The notice keeps it off the board.", [span("e2", "keeps the Saturday ferry off the board")]),
  ),
  recorded("a3n", "q3", "no_research", 1, output(0.5, "The question text alone is a coin flip.")),
  // Paraphrased claim: span_not_in_excerpt, then a structural correction with an exact quote.
  recorded(
    "a3r1",
    "q3",
    "research",
    1,
    output(0.33, "A wing still described as a site in July is unlikely to be ready quickly.", [
      { ...span("e3", "still call the wing a construction site"), text: "July minutes still describe the wing as a construction site." },
    ]),
  ),
  recorded("a3r2", "q3", "research", 2, output(0.35, "A wing still described as a site in July is unlikely to be ready quickly.", [span("e3", "still call the wing a construction site")])),
  recorded("a4n", "q4", "no_research", 1, output(0.44, "Seasonal shipments miss as often as they land.")),
  // Cites a rejected undated source: whole attempt withheld. The correction has a bad hash: arm ends withheld after two calls.
  recorded(
    "a4r1",
    "q4",
    "research",
    1,
    output(0.58, "A short crop can still ship if a late buyer appears.", [
      span("e4a", "a short crop and no booked cold storage"),
      { text: "the pears shipped early", evidenceId: "e4b", start: 20, end: 43, contentHash: sha256Hex(byId("e4b").excerpt) },
    ]),
  ),
  recorded(
    "a4r2",
    "q4",
    "research",
    2,
    output(0.52, "A short crop can still ship if a late buyer appears.", [{ ...span("e4a", "a short crop and no booked cold storage"), contentHash: "0".repeat(64) }]),
  ),
  recorded("a5n", "q5", "no_research", 1, output(0.66, "A lighthouse rebuild often slips past the first announced date.")),
  recorded("a6n", "q6", "no_research", 1, output(0.4, "Temporary booths often close early.")),
  recorded(
    "a6r",
    "q6",
    "research",
    1,
    output(0.2, "Weekend-only staffing makes a full season less likely, despite the spring plan.", [
      span("e6", "lists the booth as weekend only"),
      span("e6b", "plans to keep the Pier 4 booth open until 1 October"),
    ]),
  ),
];

const QUESTIONS: ManifestQuestion[] = [
  evaluation("q1", "civic-works", "northglass-bridge", "Will the fictional city of Northglass open its river bridge by 2 November 2024?", "2024-03-01T00:00:00.000Z", "2024-06-01T00:00:00.000Z", "2024-11-02T00:00:00.000Z", 1, "Northglass opened the river bridge on 2 November 2024."),
  evaluation("q2", "transport", "harbor-line", "Will the fictional Harbor Line resume its Saturday ferry by 1 March 2025?", "2024-09-01T00:00:00.000Z", "2024-12-01T00:00:00.000Z", "2025-03-15T00:00:00.000Z", 0, "Harbor Line did not resume the Saturday ferry."),
  evaluation("q3", "civic-works", "ash-court", "Will the fictional museum wing called Ash Court open by 15 January 2025?", "2024-05-01T00:00:00.000Z", "2024-08-01T00:00:00.000Z", "2025-01-20T00:00:00.000Z", 1, "Ash Court opened to visitors on 20 January 2025."),
  evaluation("q4", "commerce", "orchard-coop", "Will the fictional orchard co-op ship its winter pears before 20 December 2024?", "2024-06-01T00:00:00.000Z", "2024-09-01T00:00:00.000Z", "2024-12-21T00:00:00.000Z", 0, "The orchard co-op missed the winter pear shipment."),
  evaluation("q5", "civic-works", "ashpier", "Will the fictional Ashpier lighthouse lens be relit by 1 June 2025?", "2024-10-01T00:00:00.000Z", "2025-01-01T00:00:00.000Z", "2025-06-02T00:00:00.000Z", 1, "The Ashpier lens was relit on 2 June 2025."),
  evaluation("q6", "civic-services", "pier4", "Will the fictional census booth on Pier 4 stay open through 1 October 2024?", "2024-04-01T00:00:00.000Z", "2024-07-01T00:00:00.000Z", "2024-10-03T00:00:00.000Z", 0, "The Pier 4 census booth closed before October 2024."),
  training("t1", "civic-works", "t-quay-wall", "Will the fictional quay wall reopen by March 2023?", "2022-10-01T00:00:00.000Z", "2023-03-10T00:00:00.000Z", 1),
  training("t2", "civic-works", "t-library", "Will the fictional library annex open by June 2023?", "2023-01-01T00:00:00.000Z", "2023-06-20T00:00:00.000Z", 0),
  training("t3", "transport", "t-tram", "Will the fictional harbor tram run on Sundays by May 2023?", "2023-01-15T00:00:00.000Z", "2023-05-15T00:00:00.000Z", 1),
  training("t4", "commerce", "t-market-hall", "Will the fictional market hall add a night market by October 2023?", "2023-04-01T00:00:00.000Z", "2023-10-05T00:00:00.000Z", 0),
  training("t5", "civic-services", "t-clinic", "Will the fictional pier clinic extend hours by January 2024?", "2023-08-01T00:00:00.000Z", "2024-01-12T00:00:00.000Z", 1),
  training("t6", "civic-works", "t-seawall", "Will the fictional seawall repairs finish by April 2024?", "2023-10-01T00:00:00.000Z", "2024-04-02T00:00:00.000Z", 0),
];

const HARBOR: Manifest = {
  schemaVersion: 1,
  datasetId: "harbor-demo-v1",
  name: "Harbor fixtures (synthetic)",
  kind: "synthetic",
  provenance: "First-party synthetic fixture written for this repository. All places, dates, prices and outputs are fictional.",
  rights: "MIT licensed with this repository; freely shareable.",
  protocol: {
    protocolId: "harbor-protocol-v1",
    cutoffPreset: "supplied-fixed-v1",
    cutoffSelectionNote: "Fixed fictional cutoffs, frozen together and labelled retrospectively selected.",
    fallbackPolicy: FALLBACK_POLICY,
    sourceBufferHours: 0,
    maxPriceAgeHours: 24,
    trainMinimum: 10,
    calibrationBins: 5,
    maxPromptExcerpts: 8,
    eligibilityNote: "Six fictional evaluation items and six disjoint training items; base rate needs n >= 10 and is shown as unavailable.",
    modelProfileVersion: "recorded-demo",
    promptVersion: PROMPT_VERSION,
    gateVersion: GATE_VERSION,
    blocklistVersion: BLOCKLIST_VERSION,
    bootstrapSeed: 14,
    bootstrapReplicates: 2000,
  },
  questions: QUESTIONS,
  evidence: EVIDENCE,
  marketObservations: OBSERVATIONS,
  recordedAttempts: ATTEMPTS,
};

/**
 * The Harbor manifest in the on-disk import shape. Question cutoffs use the import key "cutoffAt";
 * importManifestText() reads it into ManifestQuestion.suppliedCutoffAt.
 */
export function harborManifestJson(): string {
  return JSON.stringify(
    {
      ...HARBOR,
      questions: HARBOR.questions.map(({ suppliedCutoffAt, ...rest }) => ({ ...rest, cutoffAt: suppliedCutoffAt })),
    },
    null,
    2,
  );
}

/** Parsed on-disk Harbor manifest, as importManifest() receives it from a file. */
export function harborManifestValue(): unknown {
  return JSON.parse(harborManifestJson());
}
