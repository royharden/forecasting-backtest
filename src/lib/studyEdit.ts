/**
 * Draft workshop helpers. A draft is editable manifest v1 JSON; freezing it creates a new immutable
 * DatasetVersion. Editing a draft never changes an earlier frozen version or run.
 */

import { BLOCKLIST_VERSION, FALLBACK_POLICY, GATE_VERSION, PROMPT_VERSION } from "../../supabase/functions/_shared/engine.ts";

/** A minimal real-data template: placeholders the owner must replace with permitted historical records. */
export function blankRealDraft(): string {
  return JSON.stringify(
    {
      schemaVersion: 1,
      datasetId: "my-dataset",
      name: "My resolved questions",
      kind: "real",
      provenance: "Describe where each record came from (owner-obtained venue export, archive captures).",
      rights: "State the licence or permission for every excerpt; private use still needs permission.",
      protocol: {
        protocolId: "my-protocol-v1",
        cutoffPreset: "supplied-fixed-v1",
        cutoffSelectionNote: "Cutoffs chosen before scoring and frozen together; retrospectively selected.",
        fallbackPolicy: FALLBACK_POLICY,
        sourceBufferHours: 24,
        maxPriceAgeHours: 24,
        trainMinimum: 10,
        calibrationBins: 5,
        maxPromptExcerpts: 8,
        eligibilityNote: "Resolved binary questions with historical wording proof.",
        modelProfileVersion: "recorded",
        promptVersion: PROMPT_VERSION,
        gateVersion: GATE_VERSION,
        blocklistVersion: BLOCKLIST_VERSION,
        bootstrapSeed: 14,
        bootstrapReplicates: 2000,
      },
      questions: [
        {
          id: "Q1",
          role: "evaluation",
          category: "category",
          eventClusterId: "cluster-1",
          questionTextAsOf: "Question wording exactly as it read at the cutoff.",
          resolutionRulesAsOf: "Resolution rules exactly as they read at the cutoff.",
          opensAt: "2024-01-01T00:00:00Z",
          wordingAvailableAt: "2024-01-01T00:00:00Z",
          wordingVersionProof: "Archive capture ID or venue revision showing this wording existed by then.",
          cutoffAt: "2024-03-01T00:00:00Z",
          scheduledCloseAt: null,
          scheduledCloseProvenance: null,
          actualCloseAt: null,
          resolvedAt: "2024-06-01T00:00:00Z",
          outcome: 1,
          resolutionAuditText: "Offline resolution sentence for the post-inference tripwire (never sent to a model).",
        },
      ],
      evidence: [
        {
          id: "E1",
          questionId: "Q1",
          title: "Source title",
          url: "https://example.org/article",
          published: { precision: "instant", at: "2024-02-20T12:00:00Z" },
          retrievedAt: "2024-02-21T00:00:00Z",
          versionAvailableAt: "2024-02-20T12:00:00Z",
          versionProof: "Archive capture ID showing this exact text by the evidence cutoff.",
          updatedAt: null,
          excerpt: "Exact permitted excerpt text.",
          rightsNote: "Licence or permission for this excerpt.",
        },
      ],
      marketObservations: [
        { id: "M1", questionId: "Q1", yesProbability: 0.5, observedAt: "2024-02-29T12:00:00Z", venue: "Venue name", provenance: "Owner export file and row" },
      ],
      recordedAttempts: [],
    },
    null,
    2,
  );
}
