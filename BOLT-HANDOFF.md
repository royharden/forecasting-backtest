# Bolt infrastructure handoff: forecasting-backtest

Product: a **supplied-evidence backtest** for resolved yes/no questions. Retrieval is unavailable (optional M5 not implemented); scores evaluate supplied evidence, not a search service.

This is the single product infrastructure inventory. Full-mode local validation started on 2026-10-26. Frontend install/test/type/build, edge typecheck/keyless handler tests, and migrations with synthetic database regressions have run successfully. Deployment and real provider/auth-email behavior remain unverified. Local PostgreSQL uses a synthetic `auth.uid()`/role shim; it does not prove a deployed Supabase gateway or email flow.

## Target and readiness

- Repository: local git only, branch `main`, no remote. Read the inner repo for the current revision; a hash in this file is not a pin.
- App root: the inner `forecasting-backtest` folder (repository root).
- Database: Bolt Database (Supabase Postgres 15+ required: migrations use `ON DELETE SET NULL (column)`).
- Deployment baseline: unknown/uninspected. The earlier file `20261023150000_study.sql` is byte-identical to its original commit. All five migrations apply on fresh local PostgreSQL 17.6. Inspect a future target's actual migration ledger before applying anything; a drifted or unknown target needs reconciliation first.
- Hosting and publication: prepare only.
- Bolt action now: **inspect and prepare only** (prompt at the end). Provisioning, secrets, deploy and live enablement are later, separately authorized steps.
- Status: M1–M4 source complete; local runtime validation and independent acceptance in progress. M5 retrieval is not implemented ("retrieval unavailable").

| Resource | Written | Applied / deployed | Verified |
|---|---|---|---|
| Browser app (Vite/React) | yes | no deployment | install/type/test/build and keyless browser download/Verify/tamper journey pass locally |
| 5 SQL migrations | yes | disposable local DB only | full chain and synthetic RLS/replay/audit/Unicode regressions pass |
| `forecast` edge function | yes | no deployment | Deno check and 4 keyless handler tests pass |
| Server secrets | names only | no | no |
| `model_profiles` row / live enablement | no (owner step) | no | no |

## Build and connection

| Item | Exact command or name |
|---|---|
| Runtime | Node 24.18.0 / npm 11.11.0 validated; Node 22.6+ required for the offline type-stripping command. Committed npm and Deno locks. |
| Install | `npm ci` (project-local pinned dependency resolution). |
| Checks | `npm test`, `npm run typecheck`, `npm run build` pass locally. Serial tests can use `--maxWorkers=1 --minWorkers=1` on a busy host. |
| Offline normalizer | `npm run prepare-manifest -- <input.json> <out.json>`; worked examples checked by `node --experimental-strip-types scripts/validate-normalizer.mjs`. |
| Edge type/handler checks | `npm exec -- deno check supabase/functions/forecast/index.ts`; `npm exec -- deno test supabase/functions/forecast/handler_test.ts` (keyless, mocked network). Deployed bundling remains pending. |
| Public env names | `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (`src/lib/config.ts`). |
| Missing public config | The app opens in browser-only mode: synthetic demo, manifest import, replay, export and Verify all work without a database. |

## Database: forward migrations in order

| Order | File | Resources | Applied |
|---|---|---|---|
| 1 | `supabase/migrations/20261023150000_study.sql` | Draft tables `study_sets`, `questions`, `sources`, `claims`, `forecasts`, `runs` + RLS. Kept byte-for-byte. | pending / unknown |
| 2 | `supabase/migrations/20261024000100_run_versions.sql` | `app_private` schema + `app_private.fail`; frozen `dataset_versions`, `version_questions`, `version_outcomes`, `version_evidence`, `version_prices`, `version_quarantine`, `version_recordings`; `model_profiles`; extends `runs` (dataset_version_id, status, mode, manifest_hash, linked_run_id, finalized_at; set_id nullable); `run_manifests`, `run_items`, `run_prompt_evidence`, `run_arm_attempts`, `run_claim_decisions`; fixes the legacy `claims_owner` policy qualification; forecasts limited to `origin='recorded'` with claim-id validation. RPCs: `finalize_dataset`, `dataset_version_rows_hash`, `freeze_run`, `finalize_run`, `record_prompt_evidence` (service only). | pending |
| 3 | `supabase/migrations/20261024000200_attempt_limits.sql` | `app_limits` (single row: 50/user/day, 200/app/day, MAX_RUN_USD 1, MAX_USER_DAY_USD 3, MAX_APP_DAY_USD 10, live_enabled false), `usage_counters`, `provider_attempts`. Service-only RPCs: `lease_arm`, `reserve_attempt`, `finalize_attempt`, `finalize_arm_result`. | pending |
| 4 | `supabase/migrations/20261024000300_audit_reports.sql` | `audit_samples`, `audit_sample_items`, `audit_verdict_editions` (append-only), `report_cache`. RPCs: `create_audit_sample`, `append_audit_verdict`. | pending |
| 5 | `supabase/migrations/20261026000100_unicode_integrity.sql` | Exact UTF-16 supported-claim span trigger and UTF-16 audit population ordering, including supplementary characters. | local test DB only |

Apply files 2–5 together before enabling the app (file 2's `freeze_run` reads `app_limits` from file 3). Assumes the baseline FK is named `runs_set_id_fkey` and existing `runs` rows (if any) have a same-owner `set_id`.

- Access model: RLS on every table; owner-only select through every parent path. Frozen tables have no client write grants; they change only through the RPCs. No anonymous grants.
- Error contract: RPCs raise MESSAGE = public code with SQLSTATE `PTnnn` (HTTP status): `invalid_input` 400, `invalid_session` 401, `not_found` 404, `frozen_or_mismatch` / `in_progress` / `manifest_or_config_mismatch` 409, `budget_exhausted` 429, `configuration_required` 503.
- Hash reconciliation: SQL cannot recompute the engine's canonical JSON hashes (jsonb reorders keys). The server stores the engine `version_hash` as a claim plus its own `rows_hash`; the browser recomputes engine hashes when reopening a stored version and in Verify bundle. Single-string hashes (evidence `content_hash`, prompt `excerptHash`) are recomputed in SQL.
- ID ordering: audit sampling uses an explicit UTF-16 sort key in SQL to match the engine, including supplementary-plane IDs. Run cohort keys are compared as sets. Mixed-Unicode sampling parity and split-surrogate rejection are exercised by the local DB regression.
- `freeze_run` does not re-check the model allowlist, online-variant or prompt-version rules; the `forecast` function enforces them at every call.
- `finalize_attempt` permits `unknown -> failed_*` settlement; the charge is kept either way.
- Provider transient/terminal outcomes are returned by `forecast` as HTTP 200 with the item state and `reasonCode` (`provider_transient`, `provider_terminal`), so the browser loop can continue; the plan's `502` codes are represented by these persisted item states. Configuration, auth, ownership, budget and mismatch refusals keep their HTTP codes.
- Known rare races (Postgres resolves them; no data is wrong): a deadlock between `finalize_run`/`reserve_attempt` and `finalize_attempt` lock orders is detected and aborted by Postgres; a request whose 90 s lease expired after its 50 s provider deadline could in theory overlap a replacement call. Both are runtime checks in the pending list.
- No storage buckets, no Realtime, no cron, no seeds. The Harbor demo is client data in `src/lib/demoPack.ts`; do not load it as SQL.

## Functions

| Name / source | Caller + auth | Input → output | Secrets | Config |
|---|---|---|---|---|
| `forecast` — `supabase/functions/forecast/index.ts` (imports `../_shared/engine.ts`) | Signed-in JWT (`verify_jwt = true`); handler re-checks with `auth.getUser`, reads frozen rows through RLS, then calls service-only RPCs. | POST `{runId, questionId, arm, requestKey}` (≤16 KiB) → `{runId, itemId, attemptId, status, reasonCode, retryNotBefore, armPrediction, withheldProbability, claimDecisions, usageStatus}`; errors `{error, message}` with the codes above. | `XAI_API_KEY` (live only), `FORECAST_MODEL_ID`, optional `APP_ORIGIN`; platform `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`. | `supabase/config.toml` |

- One arm stage per call; at most one provider call; lease 90 s; fetch deadline 50 s; response streamed and capped at 64 KiB; no SDK retries, no sleeps. Transient (429/5xx/network) keeps the charge and schedules the remaining slot via `retry_not_before` (Retry-After clamped 1–300 s, default 5 s); auth/request/policy/schema errors are terminal.
- No-browsing guards: fixed endpoint `https://api.x.ai/v1/chat/completions`, model must equal `FORECAST_MODEL_ID` and the pinned profile, payload keys allowlisted (no tools/plugins/search parameters), online variants rejected, tool-call/citation responses rejected.
- Replay runs read `version_recordings` only; there is no provider path. A missing recording ends the arm `replay_miss` (returned as HTTP 200 with `reasonCode: "replay_miss"` and no attempt row, so the browser loop can finish the run; the plan's `replay_miss409` is represented by this terminal item state).
- A charge whose lease expired before its result was written is recorded at the next call as a failed `provider_transient` attempt (`lease_expired_unknown_charge`), keeping its reservation; any refusal after leasing releases the lease.
- Live preconditions (all checked before any reservation): `XAI_API_KEY` set, `FORECAST_MODEL_ID` equals an **enabled** `model_profiles` row whose profile was pinned in the run, `app_limits.live_enabled = true`, verified pricing/tokenization/reasoning billing in the profile, declared training cutoff before every evaluation question opened.
- CORS: `APP_ORIGIN` allowlist when set, otherwise `*`. CORS is not authentication.

## Server secrets and settings (owner enters; none exist now)

| Name | Consumer | Required | Source |
|---|---|---|---|
| `XAI_API_KEY` | `forecast` | Live mode only | xAI console |
| `FORECAST_MODEL_ID` | `forecast` | Live mode only | Owner-confirmed xAI model ID (`grok-4.7` from the earlier build is unverified) |
| `APP_ORIGIN` | `forecast` CORS | Optional | Deployed site origin(s) |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | `forecast` | Yes | Platform-injected; service role is used only after JWT/ownership checks |
| `public.model_profiles` row + `enabled` | `forecast`, client | Live mode only | Owner inserts via SQL editor after verifying model cutoff/source/date, prices, tokens per byte, reasoning billing |
| `public.app_limits.live_enabled` | RPCs | Live mode only | Owner sets after the above |
| `EXA_API_KEY` | none | Optional M5 only; not implemented — do not set | — |

Never put a provider or service secret in a `VITE_` name, browser code, exports, logs or a checked-in env file.

## Auth settings (owner)

Email/password sign-in, sign-up and password recovery are in `src/components/AuthBar.tsx`. Recovery uses `resetPasswordForEmail(..., { redirectTo: window.location.origin })`. The owner configures email confirmation, Site URL and allowed redirect URLs to include the deployed origin.

## Pending verification (in priority order)

1. Independent acceptance of the local full-mode packages; the original unit/build, browser, normalizer, Deno and disposable-DB checks now have executed results.
2. On a future authorized Bolt target, inspect its migration ledger and reconcile all five migrations; verify real JWT-to-RLS behavior and deployed bundling of `../_shared/*.ts`. Local database checks use synthetic identities, not a deployed authentication service.
3. Verify production redirects and password-recovery email, gateway JWT settings, allowed origins and deployed missing-configuration behavior. Local CORS/auth/input guards are covered by keyless handler tests.
4. Only after owner authorization and verified model metadata: one bounded live call; inspect usage/cost/retry records and export reproduction. No live price/model compatibility or paid-call result is claimed here.

## Inspect-and-prepare prompt for Bolt (no provisioning)

> Inspect this repository. Do not create or modify databases, apply migrations, deploy functions, set secrets or publish. Report the Node/npm versions you would use; whether `npm ci`, `npm test`, `npm run typecheck` and `npm run build` succeed (run them only if this environment permits installs, and report failures verbatim); whether a Bolt Database is attached and, if so, its applied migration ledger compared with `supabase/migrations/` (five files, in order); and whether `supabase/functions/forecast` bundles with its `../_shared/` imports. Propose, but do not perform, pending migration reconciliation and deployment of `forecast`.

A prepared prompt is not an action.
