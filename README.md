# Forecasting backtest

A **supplied-evidence backtest** workbench for already resolved yes/no questions. It compares a researched forecast with a no-research forecast, the market price as of the cutoff, a training-cohort base rate and an always-0.5 reference, under a frozen cutoff protocol, and shows exactly what each result can and cannot establish.

It does not trade, forecast open questions, connect wallets or give investment advice. Retrieval from the web is **not implemented**: scores evaluate the evidence you supply, not a search service.

## Status: source complete, nothing has run

This version was built in Dirty Mode (static construction only) on 2026-10-23. The source for the plan's required milestones M1–M4 is written, and each package passed an independent static review (reviews only read the code). **Nothing has been executed**: no `npm install`, no lockfile, no unit tests, no type check, no build, no browser session, no migration, no deployed function, no model call. The test files under `tests/` were written but never run. Treat every behavior below as intended, not proven. A check that fails later is a failure, not a formality.

## The no-cost demo

No account or database needed. Choose **Enter synthetic demo**:

1. Six fictional resolved Harbor questions load with a frozen protocol card (supplied-fixed cutoffs, 0h synthetic source buffer, 5 calibration bins) and six disjoint training items.
2. Each question shows its as-of wording and the outcome-independent source decisions: kept, blocklisted (encyclopedia, prediction-market page), undated, published after the cutoff (including a date-only source on the cutoff day), version not proven, update marker (undated "Updated:" edit), duplicate.
3. **Run recorded replay** pushes hand-written recorded outputs through the same gate, exact-span critic, one-correction rule and post-inference audit. It has no model path.
4. Inspect exact claim spans: one paraphrased claim is corrected on the second attempt, one arm cites a rejected source and ends withheld after two calls, one repeats the hidden resolution sentence and is withheld by the audit, one question has an empty strict evidence pack so research is skipped. Memory checks are N/A for synthetic data.
5. Compare **policy minus market** (primary, on the 4 questions with a valid market price), the strict research result (conditional on 3 valid outputs) and the reason counts. The base rate is shown as unavailable (training n < 10): the floor is not lowered.
6. Inspect calibration counts, draw a fixed audit sample and append verdicts.
7. **Download audit bundle**, then load it in **Verify a bundle file**, which recomputes the hashes, gate, critic decisions and metrics.

Demo state lasts only for the page session. Synthetic numbers demonstrate arithmetic and control flow, never real model performance. On Harbor the policy loses to the market (mean Brier difference about +0.084), which is a valid result.

## Rules in brief

- **Manifest v1**: explicit-UTC timestamps only; unique IDs; ≤1 MiB, ≤100 questions, ≤50 evidence candidates and ≤50 price observations per question. Structural problems reject the whole import; temporal, wording and outcome problems become visible quarantine rows. Requires `opensAt ≤ wordingAvailableAt ≤ cutoffAt < resolvedAt ≤ freeze time` and an outcome of exactly 0 or 1.
- **Cutoff presets**: `supplied-fixed-v1` (frozen together, labelled retrospectively selected) or `scheduled-midpoint-v1` (needs a historical scheduled close; excludes short lifetimes and early closes instead of clamping). Neither removes selection or survivor bias.
- **Evidence gate** (outcome-independent, first failure wins): wrong question, no rights note, blocklisted source (hostname boundary), undated, latest possible publication after `evidenceCutoff = cutoff − buffer` (real 24h), historical version not proven, update marker, duplicate content, over the 8-excerpt cap. Every candidate has a ledger row and the funnel balances.
- **Prompts** use only as-of wording, rules, the cutoff and the frozen evidence pack. Outcomes, resolution text, prices and other arms never enter a model request or its cache key.
- **Critic**: research claims must be exact UTF-16 spans of a kept excerpt with its hash. Any unsupported claim withholds the whole research probability (kept unscored). One structural correction per arm, with only claim indices and codes as feedback. Two charged calls per arm in total.
- **Arms and scores**: market (last price ≤ cutoff, ≤24h old, conflicting same-time prices unavailable), training base rate (n ≥ 10), always 0.5, no research, strict research (conditional), and the named policy `research_else_noResearch_else_half`. Brier, skill against 0.5 on identical IDs, frozen calibration bins; log loss, ECE and binned Murphy in a secondary panel. Real paired cohorts with n ≥ 30 and ≥ 10 event clusters get a seeded cluster bootstrap interval; nothing else gets an interval, and there are no p-values.
- **Audit**: fixed sample of kept evidence, append-only verdict editions, rates over reviewed k beside sampled n and population N. It cannot prove that no leak exists.

## Real-data worked manifest (illustrative template)

Real questions are supported. No real data ships with this repository, because the rights to redistribute venue records and news excerpts must be checked separately. The example below is an **illustrative template with fictional values**; replace every value with records you are permitted to use.

Prepare a loose input file from your own exports and archives, then normalize and validate it offline:

```bash
npm run prepare-manifest -- my-input.json my-manifest.json
```

The script never accesses a network or API, never invents wording, prices, dates or outcomes, and reports every rejected or quarantined row on stderr. Example input with one resolved question:

```json
{
  "dataset": { "datasetId": "ex-1", "name": "Example", "kind": "real",
               "provenance": "Owner venue export 2025-01-10; archive captures listed per row",
               "rights": "Private research use under the venue's terms; excerpts quoted with permission" },
  "questions": [{
    "id": "Q1", "category": "elections", "cluster": "city-vote-2024",
    "question_text_as_of": "Will Measure A pass in the 5 Nov 2024 city vote?",
    "rules_as_of": "Resolves YES if certified results show Measure A passing.",
    "opened_at": "2024-08-01T00:00:00Z",
    "wording_captured_at": "2024-08-02T00:00:00Z",
    "wording_proof": "Archive capture id 20240802-abc (question page revision 3)",
    "cutoff_at": "2024-10-20T00:00:00Z",
    "resolved_at": "2024-11-20T00:00:00Z",
    "outcome": "YES",
    "resolution_note": "Measure A passed with 58 percent."
  }],
  "prices": [
    { "question_id": "Q1", "price": 61, "unit": "cents", "observed_at": "2024-10-19T18:00:00-04:00", "venue": "Venue", "source": "export.csv row 812" }
  ],
  "evidence": [{
    "id": "E1", "question_id": "Q1", "title": "Poll shows Measure A ahead",
    "url": "https://news.example/poll", "published_at": "2024-10-15T09:00:00Z", "retrieved_at": "2025-01-05T00:00:00Z",
    "archived_at": "2024-10-15T12:00:00Z", "archive_id": "capture 20241015-xyz",
    "text": "A poll released Tuesday shows 55 percent support for Measure A.",
    "licence": "Quoted with permission"
  }]
}
```

Required fields: category and event cluster per question, venue and provenance per price, retrieval time per excerpt (nothing is filled in for you). Required historical fields: the wording and rules **as they read at the cutoff** with a version proof (text scraped after resolution is not an as-of record and is quarantined as `wording_unproven`), each excerpt's original publication time and an archive time/proof showing that exact version existed by the evidence cutoff (otherwise `version_unavailable`), and a rights note per excerpt. Timestamps with numeric offsets are converted to UTC; timestamps with no timezone are rejected, never guessed.

Market selection: the scorer takes the last observation at or before the cutoff that is at most 24h old. Here the 18:00 −04:00 price (22:00Z on 19 Oct) is selected as 0.61. A later price is never used, a stale price makes the market arm unavailable, and two different prices at the same timestamp are ambiguous, not averaged.

Rejection diagnostics look like `REJECT prices[3]: observed_at "2024-10-19 18:00" has no explicit timezone or is invalid; it was not guessed.` and `WARN question Q7: quarantined: temporal_order — Requires opensAt <= ...`.

Then import the manifest with **Import manifest v1** or paste it into the **Draft workshop**. For a real model comparison you also need recorded outputs (`recordedAttempts`, origin `recorded` or `manual`) or a configured live profile.

## Accounts and live forecasts (configured mode)

With `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` set and a signed-in user, the **Account storage** panel stores frozen versions privately (one atomic `finalize_dataset`), runs recorded replay or live runs through the `forecast` function arm by arm while the page is open, and reopens stored runs by recomputing their scores from the frozen rows. Live mode stays disabled until the owner verifies a model profile and enables it (see `BOLT-HANDOFF.md`). Live calls use the existing xAI adapter with server-only `XAI_API_KEY`; no other provider is implemented.

## Stack

React 19, TypeScript, Vite 6, Vitest 3, supabase-js 2. One pure engine in `supabase/functions/_shared/` (barrel `engine.ts`) is shared by the browser, the Deno edge function and the offline script. Four SQL migrations under `supabase/migrations/`. One Deno edge function, `forecast`.

## Later setup (not run)

```bash
npm install          # creates package-lock.json; commit it, then use npm ci
npm test
npm run typecheck
npm run build
npm run dev          # claim a port with the agent-ports skill first
```

Copy `.env.example` to `.env.local` only when a real Bolt Database URL and anon key exist. Server secrets go in function settings, never in `VITE_` names. `BOLT-HANDOFF.md` lists migrations, functions, secrets and the pending verification steps.

## What has not run

- Dependency install, lockfile, Vitest, `tsc`, Vite build
- Any browser use of the screens, including the demo journey and bundle verification
- `deno check` or deployment of `forecast`
- Migrations, RLS with two users, counters, leases, audit RPCs
- Auth email/recovery settings
- Any real model response

## Licence

MIT (see `LICENSE`). The licence covers this software only, not third-party datasets, market data or news text.
