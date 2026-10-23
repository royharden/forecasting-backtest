import { describe, expect, it } from "vitest";
import {
  admitSource,
  baseRateAtCutoff,
  brierScore,
  brierSkill,
  buildForecastPrompt,
  expectedCalibrationError,
  logLoss,
  murphySplit,
  parseModelPayload,
  reviewClaim,
  runBacktest,
  selectPromptSources,
  type QuestionRecord,
  type SourceRecord,
} from "../supabase/functions/_shared/engine.ts";
import { demoStudy } from "../src/lib/demoPack.ts";

const question = demoStudy().questions[0];

function source(partial: Partial<SourceRecord> & Pick<SourceRecord, "id">): SourceRecord {
  return {
    questionId: question.id,
    title: "Note",
    url: "",
    publishedAt: "2024-05-01T00:00:00.000Z",
    body: "A dated note with no outcome sentence.",
    ...partial,
  };
}

describe("scores", () => {
  it("scores a perfect binary forecast at zero Brier", () => {
    expect(brierScore([{ probability: 1, outcome: 1 }, { probability: 0, outcome: 0 }])).toBe(0);
  });

  it("scores always-0.5 at 0.25 and reports skill against that reference", () => {
    const pairs = [
      { probability: 0.5, outcome: 1 as const },
      { probability: 0.5, outcome: 0 as const },
    ];
    expect(brierScore(pairs)).toBe(0.25);
    expect(brierSkill(0.1, 0.25)).toBeCloseTo(0.6);
  });

  it("keeps log loss finite when a probability is 0 or 1", () => {
    const loss = logLoss([{ probability: 0, outcome: 1 }]);
    expect(loss).not.toBeNull();
    expect(loss as number).toBeGreaterThan(10);
    expect(Number.isFinite(loss)).toBe(true);
  });

  it("reports zero ECE when every forecast matches the outcome in its bin", () => {
    const pairs = [
      { probability: 1, outcome: 1 as const },
      { probability: 1, outcome: 1 as const },
    ];
    expect(expectedCalibrationError(pairs)).toBe(0);
  });

  it("makes the Murphy split equal reliability minus resolution plus uncertainty", () => {
    const pairs = [
      { probability: 0.1, outcome: 0 as const },
      { probability: 0.15, outcome: 1 as const },
    ];
    const split = murphySplit(pairs);
    expect(split).not.toBeNull();
    expect(split?.binnedBrier).toBeCloseTo(split!.reliability - split!.resolution + split!.uncertainty);
    expect(split?.binnedBrier).not.toBeCloseTo(brierScore(pairs) as number);
  });
});

describe("admission and critic", () => {
  it("rejects an undated source and a source after the cutoff", () => {
    expect(admitSource(source({ id: "late", publishedAt: "2024-07-01T00:00:00.000Z" }), question.cutoffAt).reason).toBe(
      "after_cutoff",
    );
    expect(admitSource(source({ id: "none", publishedAt: null }), question.cutoffAt).reason).toBe("undated");
  });

  it("rejects a claim with no dated admitted source", () => {
    const study = demoStudy();
    const q4 = study.questions.find((item) => item.id === "q4");
    expect(q4).toBeDefined();
    const undated = reviewClaim(q4 as QuestionRecord, study.sources, study.claims.find((claim) => claim.id === "c4b")!);
    const dated = reviewClaim(q4 as QuestionRecord, study.sources, study.claims.find((claim) => claim.id === "c4a")!);
    expect(undated).toEqual({ claimId: "c4b", admitted: false, reason: "undated_source" });
    expect(dated.admitted).toBe(true);
    expect(reviewClaim(q4 as QuestionRecord, study.sources, { ...study.claims[0], id: "empty", text: "  ", sourceId: "s4a" }).reason).toBe(
      "empty",
    );
    expect(
      reviewClaim(q4 as QuestionRecord, study.sources, { id: "bare", questionId: "q4", text: "No cite.", sourceId: null }).reason,
    ).toBe("missing_source");
  });

  it("rejects a dated source that repeats the resolution sentence", () => {
    const leaked = source({
      id: "phrase",
      publishedAt: "2024-05-02T00:00:00.000Z",
      body: question.resolutionStatement,
    });
    expect(reviewClaim(question, [leaked], {
      id: "c-leak",
      questionId: question.id,
      text: "The note already states the ending.",
      sourceId: "phrase",
    }).reason).toBe("source_leaked");
  });
});

describe("baselines and prompt pack", () => {
  it("builds the base rate only from other questions resolved by the cutoff", () => {
    const study = demoStudy();
    const q2 = study.questions.find((item) => item.id === "q2") as QuestionRecord;
    const q5 = study.questions.find((item) => item.id === "q5") as QuestionRecord;
    const q1 = study.questions.find((item) => item.id === "q1") as QuestionRecord;
    expect(baseRateAtCutoff(study.questions, q1)).toBeNull();
    expect(baseRateAtCutoff(study.questions, q2)).toBeCloseTo(0.5);
    expect(baseRateAtCutoff(study.questions, q5)).toBeCloseTo(1 / 3);
  });

  it("leaves the outcome, the price, and post-cutoff sources out of the model prompt", () => {
    const study = demoStudy();
    const q5 = study.questions.find((item) => item.id === "q5") as QuestionRecord;
    expect(selectPromptSources(q5, study.sources)).toEqual([]);
    const built = buildForecastPrompt(q5, study.sources, "research");
    const payload = JSON.parse(built.user) as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(["arm", "cutoff_at", "question", "sources"]);
    expect(payload.market_price).toBeUndefined();
    expect(payload.outcome).toBeUndefined();
    expect(payload.resolution_statement).toBeUndefined();
    expect(built.user).not.toContain(q5.resolutionStatement);
    expect(built.user).not.toContain("0.81");
    const longSource = {
      ...study.sources[0],
      id: "long",
      questionId: q5.id,
      publishedAt: "2024-12-01T00:00:00.000Z",
      body: "x".repeat(4005),
    };
    const truncated = JSON.parse(buildForecastPrompt(q5, [longSource], "research").user) as {
      sources: { body: string }[];
    };
    expect(truncated.sources[0]?.body.endsWith(" [truncated]")).toBe(true);
    expect(truncated.sources[0]?.body.length).toBeLessThan(4020);
    const noResearch = JSON.parse(buildForecastPrompt(q5, study.sources, "no_research").user) as { sources: unknown[] };
    expect(noResearch.sources).toEqual([]);
  });
});

describe("model payload", () => {
  it("parses a fenced JSON object and rejects a probability that is not a number in range", () => {
    const parsed = parseModelPayload('```json\n{"probability": 0.42, "rationale": "Dated notes only.", "claims": [{"text": "A note.", "source_id": "s1"}]}\n```');
    expect(parsed).toEqual({
      probability: 0.42,
      rationale: "Dated notes only.",
      claims: [{ text: "A note.", sourceId: "s1" }],
    });
    expect(parseModelPayload('{"probability": "0.42", "rationale": "x", "claims": []}')).toBeNull();
    expect(parseModelPayload('{"probability": 1.2, "rationale": "x", "claims": []}')).toBeNull();
    expect(parseModelPayload("I think the chance is 0.4.")).toBeNull();
  });
});

describe("harbor demo backtest", () => {
  it("lets the market beat both recorded model arms and withholds the leaked research forecast", () => {
    const report = runBacktest(demoStudy());
    const byArm = Object.fromEntries(report.arms.map((arm) => [arm.arm, arm]));
    expect(byArm.market.count).toBe(6);
    expect(byArm.always_0_5.count).toBe(6);
    expect(byArm.no_research.count).toBe(6);
    expect(byArm.research.count).toBe(5);
    expect(byArm.base_rate.count).toBe(2);
    expect(byArm.market.brier as number).toBeLessThan(byArm.no_research.brier as number);
    expect(byArm.market.brier as number).toBeLessThan(byArm.research.brier as number);
    expect(byArm.market.brier as number).toBeLessThan(byArm.always_0_5.brier as number);

    const q5 = report.questions.find((item) => item.questionId === "q5");
    const q5Research = q5?.arms.find((arm) => arm.arm === "research");
    expect(q5Research?.scored).toBe(false);
    expect(q5Research?.probability).toBe(0.77);
    expect(q5?.flags.some((flag) => flag.code === "research_no_admitted_claim")).toBe(true);
    expect(q5?.flags.some((flag) => flag.code === "outcome_phrase")).toBe(true);

    const q6 = report.questions.find((item) => item.questionId === "q6");
    expect(q6?.flags.some((flag) => flag.code === "model_memory_risk")).toBe(true);
    expect(q6?.arms.find((arm) => arm.arm === "market")?.scored).toBe(true);

    const q4 = report.questions.find((item) => item.questionId === "q4");
    expect(q4?.flags.some((flag) => flag.code === "research_cites_rejected")).toBe(true);
    expect(q4?.arms.find((arm) => arm.arm === "research")?.scored).toBe(true);
  });

  it("does not impute a missing model forecast as 0.5", () => {
    const study = demoStudy();
    study.forecasts = study.forecasts.filter((forecast) => forecast.questionId !== "q1" || forecast.arm !== "no_research");
    const report = runBacktest(study);
    const q1 = report.questions.find((item) => item.questionId === "q1");
    const missing = q1?.arms.find((arm) => arm.arm === "no_research");
    expect(missing).toEqual({
      arm: "no_research",
      probability: null,
      scored: false,
      reason: "No forecast was recorded for this arm.",
    });
    expect(report.arms.find((arm) => arm.arm === "no_research")?.count).toBe(5);
    expect(report.arms.find((arm) => arm.arm === "always_0_5")?.count).toBe(6);
  });

  it("drops a question whose cutoff is not before resolution", () => {
    const study = demoStudy();
    const broken = study.questions[0];
    broken.cutoffAt = broken.resolvedAt;
    const report = runBacktest(study);
    const row = report.questions.find((item) => item.questionId === broken.id);
    expect(row?.eligible).toBe(false);
    expect(row?.arms.every((arm) => arm.scored === false)).toBe(true);
    expect(report.arms.find((arm) => arm.arm === "market")?.count).toBe(5);
  });
});
