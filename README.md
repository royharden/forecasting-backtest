# Forecasting backtest

A **supplied-evidence backtest** workbench for already resolved yes/no questions. It compares a researched forecast with a no-research forecast, the market price as of the cutoff, a training-cohort base rate and an always-0.5 reference, under a frozen cutoff protocol, and shows exactly what each result can and cannot establish.

It does not trade, forecast open questions, connect wallets or give investment advice. Retrieval from the web is **not implemented**: scores evaluate the evidence you supply, not a search service.

## Status: local full-mode validation

Full-mode validation began on 2026-10-26. A committed npm lockfile installs successfully; the 78 original unit tests, TypeScript check and production build pass. Deno checks the edge function separately, and four keyless handler tests pass. All five migrations apply on disposable PostgreSQL 17.6; the local database regression exercises owner isolation, frozen replay, audit sampling and Unicode claim validation. The headless browser completes keyboard entry, replay, reopen, calibration, download/Verify and tamper rejection with no external requests. Offline worked examples pass. Independent final acceptance is pending. No database or function has been deployed and no real provider call has been made.

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

### Worked scheduled-midpoint variant (illustrative)

Use the same fictional template with `dataset.cutoffPreset` set to `scheduled-midpoint-v1` and `dataset.cutoffSelectionNote` set to "Historical scheduled midpoint, frozen before scoring; early closes excluded." Remove `cutoff_at`; add question fields `scheduled_close_at: "2024-11-05T00:00:00Z"` and `scheduled_close_source: "Historical venue revision captured at opening"`. These provenance words are placeholders for an actual permitted archive record.

Opening on 1 August and a scheduled close on 5 November give a 96-day scheduled lifetime. The 48-day midpoint is **18 September 2024 00:00Z**, earlier than scheduled close minus three days; the real-data evidence cutoff is **17 September 00:00Z**. Set the illustrative price observation to `2024-09-17T18:00:00-04:00` (22:00Z, two hours before the forecast cutoff), publication to `2024-09-15T09:00:00Z` and archive time to `2024-09-15T12:00:00Z`. Resolution on 20 November never determines the cutoff. A lifetime shorter than seven days or actual close/resolution less than a day after the computed cutoff is excluded. The preset still permits selection and survivor bias.

`node --experimental-strip-types scripts/validate-normalizer.mjs` executes both worked variants and checks that missing retrieval dates and timezone-free price times are rejected. It uses only generated illustrative files in gitignored `.agent-work/normalizer/`; it acquires no real records.

## Accounts and live forecasts (configured mode)

With `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` set and a signed-in user, the **Account storage** panel stores frozen versions privately (one atomic `finalize_dataset`), runs recorded replay or live runs through the `forecast` function arm by arm while the page is open, and reopens stored runs by recomputing their scores from the frozen rows. Live mode stays disabled until the owner verifies a model profile and enables it (see `BOLT-HANDOFF.md`). Live calls use the existing xAI adapter with server-only `XAI_API_KEY`; no other provider is implemented.

## Stack

React 19, TypeScript, Vite 6, Vitest 3, supabase-js 2. One pure engine in `supabase/functions/_shared/` (barrel `engine.ts`) is shared by the browser, the Deno edge function and the offline script. Five SQL migrations under `supabase/migrations/`. One Deno edge function, `forecast`.

## Local setup

```bash
npm ci              # use the committed package-lock.json
npm test
npm run typecheck
npm run build
npm run dev          # claim a port with the agent-ports skill first
```

Copy `.env.example` to `.env.local` only when a real Bolt Database URL and anon key exist. Server secrets go in function settings, never in `VITE_` names. `BOLT-HANDOFF.md` lists migrations, functions, secrets and the pending verification steps.

Additional local checks (Node 24.18.0 and project-local Deno 2.5.6 were used):

```bash
npm exec -- deno check supabase/functions/forecast/index.ts
npm exec -- deno test supabase/functions/forecast/handler_test.ts
node --experimental-strip-types scripts/validate-normalizer.mjs
```

`scripts/validate-db.mjs <owned-s14-int-container> <new-s14-database>` creates a fresh disposable database and applies the full migration chain plus synthetic replay/RLS/Unicode regressions. It requires an explicitly owned PostgreSQL container with the test roles `anon`, `authenticated` and `service_role`; it never connects to a remote database or uses credentials. Existing database names are refused by PostgreSQL rather than overwritten.

For the built browser check, install the pinned browser in the project (`PLAYWRIGHT_BROWSERS_PATH=0 npm exec -- playwright install chromium --only-shell`, using your shell's environment syntax), claim an S14 port, start `npm exec -- vite preview --host 127.0.0.1 --port <claimed-port> --strictPort`, then run `node scripts/inspect-browser.mjs http://127.0.0.1:<claimed-port>`. Artifacts stay in gitignored `.agent-work/`. The browser blocks external requests.

## Remaining external verification

- Real Bolt/Supabase provisioning, deployed function bundling and gateway JWT behavior
- Authenticated deployed persistence and concurrent production workload behavior
- Auth email/recovery settings
- Any real model response

## Licence

MIT (see `LICENSE`). The licence covers this software only, not third-party datasets, market data or news text.
