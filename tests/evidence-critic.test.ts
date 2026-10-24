// Authored under Dirty Mode; not executed yet.
import { describe, expect, it } from "vitest";
import {
  assertNoBrowsingPayload,
  buildForecastInput,
  buildMessages,
  evaluateOutput,
  funnelBalances,
  gateEvidence,
  isBlockedHost,
  liveEligibility,
  planArm,
  readProviderResponse,
  sha256Hex,
  truncateCodePoints,
  verifyClaim,
  XAI_ENDPOINT,
  type AttemptRecord,
  type ManifestEvidence,
  type ModelProfile,
} from "../supabase/functions/_shared/engine.ts";

const Q = { id: "q", cutoffAt: "2024-08-01T00:00:00.000Z", evidenceCutoff: "2024-08-01T00:00:00.000Z" };
const PROTOCOL = { maxPromptExcerpts: 2, sourceBufferHours: 0 };

function ev(id: string, partial: Partial<ManifestEvidence> = {}): ManifestEvidence {
  const excerpt = partial.excerpt ?? `Excerpt ${id}.`;
  return {
    id,
    questionId: "q",
    title: `Title ${id}`,
    url: "https://example.invalid/a",
    published: { precision: "instant", at: "2024-07-01T00:00:00.000Z" },
    retrievedAt: "2026-01-01T00:00:00.000Z",
    versionAvailableAt: "2024-07-01T00:00:00.000Z",
    versionProof: "archive capture",
    updatedAt: null,
    rightsNote: "ok",
    ...partial,
    excerpt,
    contentHash: sha256Hex(excerpt),
  };
}

function decisionOf(rows: ManifestEvidence[], id: string, protocol = PROTOCOL) {
  return gateEvidence(Q, rows, protocol).ledger.find((d) => d.evidenceId === id)?.decision;
}

describe("evidence gate", () => {
  it("admits publication exactly at the evidence cutoff and rejects one millisecond later", () => {
    expect(decisionOf([ev("a", { published: { precision: "instant", at: "2024-08-01T00:00:00.000Z" }, versionAvailableAt: "2024-08-01T00:00:00.000Z" })], "a")).toBe("kept");
    expect(decisionOf([ev("a", { published: { precision: "instant", at: "2024-08-01T00:00:00.001Z" } })], "a")).toBe("published_after_cutoff");
  });

  it("uses the latest possible time of a date-only source instead of assuming midnight", () => {
    expect(decisionOf([ev("a", { published: { precision: "day", date: "2024-07-31" } })], "a")).toBe("kept");
    expect(decisionOf([ev("a", { published: { precision: "day", date: "2024-08-01" } })], "a")).toBe("published_after_cutoff");
  });

  it("applies the real 24h buffer through evidenceCutoff", () => {
    const real = { ...Q, evidenceCutoff: "2024-07-31T00:00:00.000Z" };
    const row = ev("a", { published: { precision: "instant", at: "2024-07-31T06:00:00.000Z" }, versionAvailableAt: "2024-07-31T06:00:00.000Z" });
    expect(gateEvidence(real, [row], PROTOCOL).ledger[0].decision).toBe("published_after_cutoff");
  });

  it("quarantines undated, unproven-version and later-edited sources", () => {
    expect(decisionOf([ev("a", { published: { precision: "unknown" } })], "a")).toBe("undated");
    expect(decisionOf([ev("a", { versionAvailableAt: null })], "a")).toBe("version_unavailable");
    expect(decisionOf([ev("a", { versionProof: "" })], "a")).toBe("version_unavailable");
    expect(decisionOf([ev("a", { updatedAt: "2024-09-01T00:00:00.000Z" })], "a")).toBe("update_marker");
    expect(decisionOf([ev("a", { excerpt: "Updated: details changed." })], "a")).toBe("update_marker");
  });

  it("admits old reporting of a planned future event; future tense is not observed future knowledge", () => {
    expect(decisionOf([ev("a", { excerpt: "The office will open the booth next spring, the plan says." })], "a")).toBe("kept");
  });

  it("matches blocked domains on hostname boundaries, not substrings", () => {
    expect(isBlockedHost("https://en.wikipedia.org/wiki/X")).toBe(true);
    expect(isBlockedHost("https://polymarket.com/event/x")).toBe(true);
    expect(isBlockedHost("https://notwikipedia.org/x")).toBe(false);
    expect(isBlockedHost("https://wikipedia.org.example.invalid/x")).toBe(false);
    expect(isBlockedHost("not a url")).toBe(false);
  });

  it("dedups by content hash, caps after a stable sort and balances the funnel", () => {
    const rows = [
      ev("d", { published: { precision: "instant", at: "2024-07-04T00:00:00.000Z" }, versionAvailableAt: "2024-07-04T00:00:00.000Z" }),
      ev("c", { excerpt: "Same text.", published: { precision: "instant", at: "2024-07-03T00:00:00.000Z" }, versionAvailableAt: "2024-07-03T00:00:00.000Z" }),
      ev("b", { excerpt: "Same text.", published: { precision: "instant", at: "2024-07-02T00:00:00.000Z" }, versionAvailableAt: "2024-07-02T00:00:00.000Z" }),
      ev("a", { published: { precision: "instant", at: "2024-07-02T00:00:00.000Z" }, versionAvailableAt: "2024-07-02T00:00:00.000Z" }),
      ev("x", { questionId: "other" }),
      ev("u", { published: { precision: "unknown" } }),
    ];
    const result = gateEvidence(Q, rows, PROTOCOL);
    // Sorted: a (07-02, id a), b (07-02, id b), c (07-03, dup of b), d (07-04, over cap 2).
    expect(result.promptEvidence.map((p) => p.evidenceId)).toEqual(["a", "b"]);
    expect(Object.fromEntries(result.ledger.map((d) => [d.evidenceId, d.decision]))).toEqual({
      d: "over_cap",
      c: "duplicate_content",
      b: "kept",
      a: "kept",
      x: "invalid_reference",
      u: "undated",
    });
    expect(result.funnel.raw).toBe(6);
    expect(result.funnel.kept).toBe(2);
    expect(funnelBalances(result.funnel)).toBe(true);
  });

  it("truncates excerpts by code points without splitting a surrogate pair", () => {
    expect(truncateCodePoints("a😀b", 2)).toEqual({ text: "a😀", truncated: true });
    expect(truncateCodePoints("ab", 2)).toEqual({ text: "ab", truncated: false });
  });
});

describe("hidden-field invariance", () => {
  it("keeps every request byte-identical when outcomes, audit text, prices and excluded future sources change", () => {
    const kept = ev("a", { excerpt: "Deck work is on schedule." });
    const futureA = ev("f", { excerpt: "It opened.", published: { precision: "instant", at: "2024-10-01T00:00:00.000Z" } });
    const futureB = ev("f", { excerpt: "It did not open, sadly, after all.", published: { precision: "instant", at: "2024-11-01T00:00:00.000Z" } });
    const base = { id: "q", questionTextAsOf: "Will it open?", resolutionRulesAsOf: "YES if open.", cutoffAt: Q.cutoffAt };
    const hiddenA = { ...base, outcome: 1, resolutionAuditText: "It opened.", marketPrice: 0.9 };
    const hiddenB = { ...base, outcome: 0, resolutionAuditText: "It did not open.", marketPrice: 0.1 };
    const gateA = gateEvidence(Q, [futureA, kept], PROTOCOL);
    const gateB = gateEvidence(Q, [kept, futureB], PROTOCOL);
    expect(gateB.promptEvidenceHash).toBe(gateA.promptEvidenceHash);
    for (const arm of ["no_research", "research"] as const) {
      const a = buildMessages(buildForecastInput(hiddenA, gateA.promptEvidence, arm), null);
      const b = buildMessages(buildForecastInput(hiddenB, gateB.promptEvidence, arm), null);
      expect(JSON.stringify(b)).toBe(JSON.stringify(a));
      const fa = buildMessages(buildForecastInput(hiddenA, gateA.promptEvidence, arm), [{ claimIndex: 0, code: "span_not_in_excerpt" }]);
      const fb = buildMessages(buildForecastInput(hiddenB, gateB.promptEvidence, arm), [{ claimIndex: 0, code: "span_not_in_excerpt" }]);
      expect(JSON.stringify(fb)).toBe(JSON.stringify(fa));
    }
  });

  it("puts only claim indices and codes into correction feedback", () => {
    const input = buildForecastInput({ id: "q", questionTextAsOf: "Q?", resolutionRulesAsOf: "R", cutoffAt: Q.cutoffAt }, [], "research");
    const user = JSON.parse(buildMessages(input, [{ claimIndex: 1, code: "unknown_source" }])[1].content);
    expect(user.correction.problems).toEqual([{ claimIndex: 1, code: "unknown_source" }]);
    expect(JSON.stringify(user)).not.toContain("rationale\":");
  });
});

describe("critic", () => {
  const rows = [ev("a", { excerpt: "The deck work was still on the published schedule." }), ev("b", { excerpt: "Second." }), ev("c", { excerpt: "Third." })];
  const gate = gateEvidence(Q, rows, PROTOCOL); // c is over cap
  const a = gate.promptEvidence[0];
  const len = (id: string) => rows.find((r) => r.id === id)?.excerpt.length ?? null;
  const out = (claims: unknown[], probability = 0.6) => JSON.stringify({ probability, rationale: "r", claims });

  it("supports an exact UTF-16 span with the excerpt hash", () => {
    const claim = { text: "still on the published schedule", evidenceId: "a", start: 18, end: 49, contentHash: a.excerptHash };
    expect(a.excerpt.slice(18, 49)).toBe(claim.text);
    expect(evaluateOutput(out([claim]), "research", gate.promptEvidence, gate.ledger, len)).toMatchObject({ status: "valid", probability: 0.6 });
  });

  it("classifies unknown, truncated-away, hash, offset and span failures", () => {
    const base = { text: "still on the published schedule", evidenceId: "a", start: 18, end: 49, contentHash: a.excerptHash };
    const check = (c: typeof base) => verifyClaim(c, gate.promptEvidence, gate.ledger, len);
    expect(check({ ...base, text: "  " })).toBe("empty");
    expect(check({ ...base, evidenceId: "zzz" })).toBe("unknown_source");
    expect(check({ ...base, evidenceId: "c" })).toBe("truncated_away");
    expect(check({ ...base, contentHash: "0".repeat(64) })).toBe("hash_mismatch");
    expect(check({ ...base, start: -1 })).toBe("invalid_offset");
    expect(check({ ...base, start: 20, end: 20 })).toBe("invalid_offset");
    expect(check({ ...base, start: 1.5 })).toBe("invalid_offset");
    expect(check({ ...base, end: 400 })).toBe("invalid_offset");
    expect(check({ ...base, start: 17, end: 48 })).toBe("span_not_in_excerpt");
  });

  it("rejects offsets that split a surrogate pair", () => {
    const emoji = gateEvidence(Q, [ev("e", { excerpt: "a😀b" })], PROTOCOL);
    const pe = emoji.promptEvidence[0];
    expect(verifyClaim({ text: "\ude00b", evidenceId: "e", start: 2, end: 4, contentHash: pe.excerptHash }, emoji.promptEvidence, emoji.ledger, () => 4)).toBe("invalid_offset");
    expect(verifyClaim({ text: "😀", evidenceId: "e", start: 1, end: 3, contentHash: pe.excerptHash }, emoji.promptEvidence, emoji.ledger, () => 4)).toBe("supported");
  });

  it("withholds the whole research probability when any attached claim fails", () => {
    const good = { text: "still on the published schedule", evidenceId: "a", start: 18, end: 49, contentHash: a.excerptHash };
    const bad = { text: "it opened", evidenceId: "zzz", start: 0, end: 9, contentHash: a.excerptHash };
    const result = evaluateOutput(out([good, bad]), "research", gate.promptEvidence, gate.ledger, len);
    expect(result).toMatchObject({ status: "withheld", probability: 0.6, correctable: true, feedback: [{ claimIndex: 1, code: "unknown_source" }] });
  });

  it("requires at least one claim for research and none for no-research", () => {
    expect(evaluateOutput(out([]), "research", gate.promptEvidence, gate.ledger, len)).toMatchObject({ status: "withheld", feedback: [{ claimIndex: 0, code: "empty" }] });
    expect(evaluateOutput(out([]), "no_research", [], [], len)).toMatchObject({ status: "valid" });
    expect(evaluateOutput(out([{ text: "x", evidenceId: "a", start: 0, end: 1, contentHash: "h" }]), "no_research", [], [], len)).toMatchObject({ status: "failed", code: "schema_invalid" });
  });

  it("rejects p outside [0,1] and nonfinite values instead of clamping", () => {
    expect(evaluateOutput(out([], 1.01), "no_research", [], [], len)).toMatchObject({ status: "failed" });
    expect(evaluateOutput('{"probability":"0.5","rationale":"","claims":[]}', "no_research", [], [], len)).toMatchObject({ status: "failed" });
    expect(evaluateOutput(out([], 0), "no_research", [], [], len)).toMatchObject({ status: "valid", probability: 0 });
    expect(evaluateOutput(out([], 1), "no_research", [], [], len)).toMatchObject({ status: "valid", probability: 1 });
  });
});

function attempt(sequence: 1 | 2, evaluation: AttemptRecord["evaluation"], kind: AttemptRecord["kind"] = "first"): AttemptRecord {
  return { attemptId: `x${sequence}`, questionId: "q", arm: "research", sequence, kind, origin: "live", requestHash: "h", promptEvidenceHash: "p", evaluation, auditFlags: [], model: null, rawText: null };
}

describe("attempt planning: two total charged calls per arm", () => {
  const withheld = { status: "withheld" as const, probability: 0.4, rationale: "", claims: [], feedback: [{ claimIndex: 0, code: "empty" as const }], correctable: true, reason: "r" };
  const transient = { status: "failed" as const, code: "provider_transient", detail: "" };
  const valid = { status: "valid" as const, probability: 0.3, rationale: "", claims: [] };

  it("skips research with an empty strict pack without a call", () => {
    expect(planArm("q", "research", 0, [])).toMatchObject({ action: "stop", result: { state: "skipped", reasonCode: "insufficient_evidence", chargedCalls: 0 } });
  });

  it("allows one correction after a structural failure, then stops", () => {
    expect(planArm("q", "research", 1, [attempt(1, withheld)])).toMatchObject({ action: "call", kind: "correction", sequence: 2, feedback: withheld.feedback });
    expect(planArm("q", "research", 1, [attempt(1, withheld), attempt(2, withheld, "correction")])).toMatchObject({
      action: "stop",
      result: { state: "withheld", withheldProbability: 0.4, probability: null, chargedCalls: 2 },
    });
  });

  it("counts a transient retry against the same two-call ceiling", () => {
    expect(planArm("q", "research", 1, [attempt(1, transient)])).toMatchObject({ action: "call", kind: "retry", sequence: 2 });
    expect(planArm("q", "research", 1, [attempt(1, transient), attempt(2, transient, "retry")])).toMatchObject({ action: "stop", result: { state: "failed", chargedCalls: 2 } });
  });

  it("does not retry terminal failures or audit withholding", () => {
    expect(planArm("q", "research", 1, [attempt(1, { status: "failed", code: "provider_terminal", detail: "" })])).toMatchObject({ action: "stop" });
    expect(planArm("q", "research", 1, [attempt(1, { ...withheld, correctable: false, feedback: [] })])).toMatchObject({ action: "stop", result: { reasonCode: "withheld_audit" } });
  });

  it("selects the first valid attempt in execution order", () => {
    expect(planArm("q", "research", 1, [attempt(2, valid, "correction"), attempt(1, withheld)])).toMatchObject({ action: "stop", result: { state: "done", selectedAttemptId: "x2", probability: 0.3 } });
  });
});

describe("no-browsing guards and live eligibility", () => {
  const profile: ModelProfile = {
    profileVersion: "p1",
    provider: "xai",
    endpoint: XAI_ENDPOINT,
    modelId: "grok-x",
    declaredTrainingCutoff: "2023-01-01T00:00:00.000Z",
    trainingCutoffSource: "vendor doc",
    trainingCutoffConfirmedAt: "2026-10-01T00:00:00.000Z",
    promptVersion: "prompt-1",
    temperature: 0,
    maxOutputTokens: 1024,
    jsonResponseFormat: true,
    pricing: { inputUsdPerMTok: 1, outputUsdPerMTok: 2, reasoningBilling: "verified_within_output_cap", maxInputTokensPerByte: 0.5, verifiedAt: "2026-10-01T00:00:00.000Z" },
  };

  it("rejects tools, search parameters, online variants and extra message fields", () => {
    const ok = { model: "grok-x", messages: [{ role: "user", content: "x" }], temperature: 0, max_tokens: 10, stream: false };
    expect(assertNoBrowsingPayload(ok, ["grok-x"])).toBeNull();
    expect(assertNoBrowsingPayload({ ...ok, tools: [] }, ["grok-x"])).toBe("payload_key_forbidden:tools");
    expect(assertNoBrowsingPayload({ ...ok, search_parameters: { mode: "on" } }, ["grok-x"])).toBe("payload_key_forbidden:search_parameters");
    expect(assertNoBrowsingPayload({ ...ok, model: "grok-x-online" }, ["grok-x-online"])).toBe("online_model_variant");
    expect(assertNoBrowsingPayload({ ...ok, model: "other" }, ["grok-x"])).toBe("model_not_allowlisted");
    expect(assertNoBrowsingPayload({ ...ok, messages: [{ role: "tool", content: "x" }] }, ["grok-x"])).toBe("message_role_forbidden");
  });

  it("rejects tool-call and citation responses", () => {
    const content = { choices: [{ finish_reason: "stop", message: { content: "{}" } }] };
    expect(readProviderResponse(content)).toMatchObject({ ok: true });
    expect(readProviderResponse({ choices: [{ finish_reason: "tool_calls", message: { content: "" } }] })).toMatchObject({ ok: false, code: "tool_call_response" });
    expect(readProviderResponse({ choices: [{ message: { content: "x", tool_calls: [{}] } }] })).toMatchObject({ ok: false, code: "tool_call_response" });
    expect(readProviderResponse({ ...content, citations: ["u"] })).toMatchObject({ ok: false, code: "tool_call_response" });
  });

  it("blocks unknown cutoffs, unverified pricing and cutoffs not before question opening", () => {
    expect(liveEligibility(profile, ["2024-01-01T00:00:00.000Z"], ["grok-x"])).toEqual({ eligible: true, reasons: [] });
    expect(liveEligibility({ ...profile, declaredTrainingCutoff: null }, [], ["grok-x"]).reasons).toContain("training_cutoff_unknown");
    expect(liveEligibility({ ...profile, pricing: null }, [], ["grok-x"]).reasons).toContain("pricing_or_tokenization_unverified");
    expect(liveEligibility(profile, ["2023-01-01T00:00:00.000Z"], ["grok-x"]).reasons).toContain("training_cutoff_not_before_question_open");
  });
});
