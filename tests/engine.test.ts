// Authored under Dirty Mode; not executed yet. Expected values are hand-derived, not copied from output.
import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  computeRequestKey,
  importManifest,
  importManifestText,
  parseUtc,
  parseUtcDate,
  publishedBounds,
  scheduledMidpointCutoff,
  sha256Hex,
  XAI_ENDPOINT,
  type ManifestQuestion,
  type ModelProfile,
} from "../supabase/functions/_shared/engine.ts";
import { harborManifestValue } from "../src/lib/demoPack.ts";

const NOW = "2026-10-23T00:00:00.000Z";

describe("canonical JSON and SHA-256", () => {
  it("sorts keys, keeps array order and writes -0 as 0", () => {
    expect(canonicalJson({ b: 1, a: [3, 1, { d: -0, c: "x" }] })).toBe('{"a":[3,1,{"c":"x","d":0}],"b":1}');
  });

  it("rejects undefined and nonfinite values", () => {
    expect(() => canonicalJson({ a: undefined })).toThrow();
    expect(() => canonicalJson([Number.NaN])).toThrow();
    expect(() => canonicalJson({ a: Infinity })).toThrow();
  });

  it("matches the FIPS 180-2 vectors", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")).toBe(
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    );
  });
});

describe("strict UTC", () => {
  it("accepts Z and +00:00 and rejects timezone-free or offset values", () => {
    expect(parseUtc("2024-06-01T00:00:00Z")).toBe(Date.UTC(2024, 5, 1));
    expect(parseUtc("2024-06-01T00:00:00.000+00:00")).toBe(Date.UTC(2024, 5, 1));
    expect(parseUtc("2024-06-01T00:00:00")).toBeNull();
    expect(parseUtc("2024-06-01T00:00:00+02:00")).toBeNull();
    expect(parseUtc("2024-02-30T00:00:00Z")).toBeNull();
    expect(parseUtc("2024-06-01")).toBeNull();
  });

  it("treats a date-only publication as [day-start, next-day-start)", () => {
    expect(parseUtcDate("2024-07-31")).toBe(Date.UTC(2024, 6, 31));
    expect(publishedBounds({ precision: "day", date: "2024-07-31" })).toEqual({ earliest: Date.UTC(2024, 6, 31), latest: Date.UTC(2024, 7, 1) });
    expect(publishedBounds({ precision: "unknown" })).toBeNull();
  });
});

function scheduled(opensAt: string, scheduledCloseAt: string, resolvedAt: string, actualCloseAt: string | null = null): ManifestQuestion {
  return {
    id: "s",
    role: "evaluation",
    category: "c",
    eventClusterId: "k",
    questionTextAsOf: "Q?",
    resolutionRulesAsOf: "R",
    opensAt,
    wordingAvailableAt: opensAt,
    wordingVersionProof: "proof",
    suppliedCutoffAt: null,
    scheduledCloseAt,
    scheduledCloseProvenance: "venue archive",
    actualCloseAt,
    resolvedAt,
    outcome: 1,
    resolutionAuditText: "",
  };
}

describe("scheduled-midpoint-v1", () => {
  it("takes the midpoint when it is earlier than close minus 3 days", () => {
    // 30-day life: midpoint 2024-01-16T00:00, close-3d 2024-01-28 -> 2024-01-16T00:00.
    const d = scheduledMidpointCutoff(scheduled("2024-01-01T00:00:00Z", "2024-01-31T00:00:00Z", "2024-02-01T00:00:00Z"));
    expect(d).toMatchObject({ ok: true, cutoffAt: "2024-01-16T00:00:00.000Z" });
  });

  it("floors to the hour", () => {
    // Opens 00:30, close 9 Jan 00:00: midpoint 5 Jan 00:15, close-3d 6 Jan 00:00 -> floor 5 Jan 00:00.
    const d = scheduledMidpointCutoff(scheduled("2024-01-01T00:30:00Z", "2024-01-09T00:00:00Z", "2024-01-10T00:00:00Z"));
    expect(d).toMatchObject({ ok: true, cutoffAt: "2024-01-05T00:00:00.000Z" });
  });

  it("excludes short lifetimes and early closes instead of clamping", () => {
    expect(scheduledMidpointCutoff(scheduled("2024-01-01T00:00:00Z", "2024-01-07T00:00:00Z", "2024-01-08T00:00:00Z"))).toMatchObject({ ok: false, reason: "midpoint_lifetime_short" });
    expect(
      scheduledMidpointCutoff(scheduled("2024-01-01T00:30:00Z", "2024-01-09T00:00:00Z", "2024-01-10T00:00:00Z", "2024-01-05T12:00:00Z")),
    ).toMatchObject({ ok: false, reason: "midpoint_closed_early" });
  });
});

function harbor(): Record<string, unknown> & { questions: Record<string, unknown>[]; evidence: Record<string, unknown>[]; recordedAttempts: Record<string, unknown>[]; protocol: Record<string, unknown> } {
  return harborManifestValue() as never;
}

describe("manifest import", () => {
  it("imports the Harbor demo with no quarantine", () => {
    const result = importManifest(harbor(), NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.version.quarantine).toEqual([]);
    expect(result.version.questions.filter((q) => q.role === "evaluation")).toHaveLength(6);
    expect(result.version.questions.find((q) => q.id === "q1")?.evidenceCutoff).toBe("2024-06-01T00:00:00.000Z");
  });

  it("fails duplicate IDs, unresolved references and forged live origin", () => {
    const dup = harbor();
    dup.evidence.push({ ...dup.evidence[0] });
    expect(importManifest(dup, NOW)).toMatchObject({ ok: false });

    const ref = harbor();
    ref.evidence[0] = { ...ref.evidence[0], questionId: "nope" };
    const refResult = importManifest(ref, NOW);
    expect(refResult.ok).toBe(false);
    if (!refResult.ok) expect(refResult.errors.some((e) => e.code === "unknown_reference")).toBe(true);

    const forged = harbor();
    forged.recordedAttempts[0] = { ...forged.recordedAttempts[0], origin: "live" };
    const forgedResult = importManifest(forged, NOW);
    expect(forgedResult.ok).toBe(false);
    if (!forgedResult.ok) expect(forgedResult.errors.some((e) => e.code === "forged_origin")).toBe(true);
  });

  it("fails timezone-free timestamps and a mismatched content hash", () => {
    const tz = harbor();
    tz.questions[0] = { ...tz.questions[0], opensAt: "2024-03-01T00:00:00" };
    expect(importManifest(tz, NOW).ok).toBe(false);

    const hash = harbor();
    hash.evidence[0] = { ...hash.evidence[0], contentHash: "0".repeat(64) };
    const result = importManifest(hash, NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((e) => e.code === "hash_mismatch")).toBe(true);
  });

  it("enforces the envelope: 1 MiB of UTF-8 text and 100 questions", () => {
    const text = importManifestText(" ".repeat(1_048_577), NOW);
    expect(text.ok).toBe(false);
    if (!text.ok) expect(text.errors[0].code).toBe("import_too_large");
    const many = harbor();
    const template = many.questions[6];
    many.questions = [...many.questions.slice(0, 6), ...Array.from({ length: 95 }, (_, i) => ({ ...template, id: `t-${i}` }))];
    const result = importManifest(many, NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((e) => e.code === "import_too_large")).toBe(true);
  });

  it("quarantines non-binary outcomes and temporal-order failures with explicit rows", () => {
    const bad = harbor();
    bad.questions[0] = { ...bad.questions[0], outcome: 0.5 };
    bad.questions[1] = { ...bad.questions[1], cutoffAt: "2025-03-15T00:00:00.000Z" }; // cutoff == resolvedAt
    const result = importManifest(bad, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.version.quarantine.map((r) => [r.targetId, r.reason])).toEqual([
      ["q1", "outcome_not_binary"],
      ["q2", "temporal_order"],
    ]);
  });

  it("requires a 24h buffer and wording proof for real datasets", () => {
    const real = harbor();
    real.kind = "real";
    expect(importManifest(real, NOW).ok).toBe(false); // synthetic 0h buffer on a real dataset
    real.protocol = { ...real.protocol, sourceBufferHours: 24 };
    real.questions[0] = { ...real.questions[0], wordingVersionProof: "" };
    const result = importManifest(real, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.version.quarantine.some((r) => r.targetId === "q1" && r.reason === "wording_unproven")).toBe(true);
    expect(result.version.questions.find((q) => q.id === "q2")?.evidenceCutoff).toBe("2024-11-30T00:00:00.000Z");
  });

  it("does not let a question resolve after the freeze time", () => {
    const result = importManifest(harbor(), "2025-01-01T00:00:00.000Z");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const reasons = result.version.quarantine.map((r) => r.targetId);
    expect(reasons).toContain("q2");
    expect(reasons).toContain("q5");
  });
});

describe("request key", () => {
  const profile: ModelProfile = {
    profileVersion: "p1",
    provider: "xai",
    endpoint: XAI_ENDPOINT,
    modelId: "m",
    declaredTrainingCutoff: null,
    trainingCutoffSource: null,
    trainingCutoffConfirmedAt: null,
    promptVersion: "prompt-1",
    temperature: 0,
    maxOutputTokens: 1024,
    jsonResponseFormat: true,
    pricing: null,
  };
  const input = {
    schema: "forecast-input-1" as const,
    promptVersion: "prompt-1",
    arm: "no_research" as const,
    questionId: "q",
    questionTextAsOf: "Q?",
    resolutionRulesAsOf: "R",
    forecastAsOf: "2024-01-01T00:00:00Z",
    evidence: [],
  };
  it("is scoped to owner and dataset version and sensitive to settings", () => {
    const base = { ownerId: "a", datasetScope: "v", profile, input, promptEvidenceHash: "h", feedback: null };
    const key = computeRequestKey(base);
    expect(computeRequestKey({ ...base, ownerId: "b" })).not.toBe(key);
    expect(computeRequestKey({ ...base, datasetScope: "w" })).not.toBe(key);
    expect(computeRequestKey({ ...base, profile: { ...profile, temperature: 0.1 } })).not.toBe(key);
    expect(computeRequestKey({ ...base })).toBe(key);
  });
});
