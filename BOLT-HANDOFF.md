# Bolt infrastructure handoff: forecasting-backtest

Dirty Mode construction — runtime unverified. The files below exist. Nothing in this inventory has been installed, migrated, deployed, or executed.

## Target and readiness

- Repository / branch / prepared revision: local git only, branch `main`, no remote. Do not treat a commit hash in this file as a pin; read the inner repo.
- App root: repository root (the inner `forecasting-backtest` folder).
- Database: Bolt Database.
- Target: fresh empty database. Do not attach or replace an existing project.
- Existing baseline / applied migrations: none. The SQL file is not evidence that it was applied.
- Hosting: prepare only. Do not publish in the inspection pass.
- Publication: prepare only.
- Bolt action: inspect and prepare only until `npm test` and `npm run build` have a real receipt. Provisioning is a later authorized step.
- Status: implementation present, runtime unverified; infrastructure pending.
- Owner prerequisites: GitHub access if the repo is later imported, a Bolt Database, and an xAI API key if live forecasts are wanted. The key is optional for the browser demo.

## Build and connection

| Item | Exact command or configuration name |
|---|---|
| Runtime / package manager | Node with npm. Versions are not pinned by a lockfile yet. `package.json` asks for TypeScript 5.8, Vite 6, Vitest 3, React 19, supabase-js 2.49. |
| Frozen install / dev | Lockfile deferred. After `npm install`, commit the lock and use `npm ci`. Dev server: `npm run dev`. |
| Build / output | `npm run build`. Vite writes `dist/`. Not run. |
| Type/lint/tests | `npm run typecheck`, `npm test`. Not run. No ESLint config. |
| Client file / public env names | `src/lib/supabaseClient.ts`. `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`. No values. |
| Missing config behavior | Empty or invalid public env opens the Harbor browser demo. The module does not throw at import. |

## Database

| Order | Exact migration file | Resources / dependencies | Applied status |
|---|---|---|---|
| 1 | `supabase/migrations/20261023150000_study.sql` | `study_sets`, `questions`, `sources`, `claims`, `forecasts`, `runs`; RLS for `authenticated`; no anon grants | pending |

- Access model: signed-in users read and write only their rows. Anonymous roles have no table grants. The browser demo does not write.
- Ownership checks: `user_id = auth.uid()`. Questions must belong to the caller's study set. Sources and forecasts must belong to the caller's question. Claims must belong to the caller's question, and a non-null source must be that user's source on the same question. Runs must belong to the caller's study set.
- Extensions/RPC permissions/Realtime: not required. `gen_random_uuid` is not required; the client supplies ids.
- Seeds: none. The Harbor set is synthetic client data in `src/lib/demoPack.ts`. Do not load it as SQL.
- Retry rule: inspect migration tracking, apply only this pending file, preserve existing data. Do not drop and recreate if a later attempt finds the tables already present.

## Functions

| Name / source | Caller + auth | Input / output | Resources + secret names | Deploy config |
|---|---|---|---|---|
| `forecast`; `supabase/functions/forecast/index.ts` | Signed-in user JWT. Gateway `verify_jwt = true`. Handler calls `auth.getUser` and uses the anon key with that JWT so RLS applies. | POST `{ questionId, arm }` where `arm` is `research` or `no_research`. 200 returns `{ forecast, claims, message }`. Errors return `{ error, message }` and do not invent a probability. | Reads `questions` and `sources`. Inserts `claims` and `forecasts`. Secrets: `XAI_API_KEY`, platform `SUPABASE_URL`, `SUPABASE_ANON_KEY`. | `supabase/config.toml` sets `verify_jwt = true`. Imports `../_shared/engine.ts`. |

- CORS/preflight: `OPTIONS` returns 204. Allow origin `*`. Allow headers `authorization, x-client-info, apikey, content-type`. Methods `POST, OPTIONS`. CORS is not authentication.
- Identity/ownership and abuse controls: the handler rejects a missing or invalid JWT, a question the caller cannot read, an ineligible question, and a research call with no admitted source. Live calls are capped at 20 per hour per account by a count of `forecasts.origin = live` in the past hour. That count is not atomic.
- Paid API limits: the cap above, a 50 second abort, at most 20 sources, and 4,000 characters of each source body. The model is not called when the secret is missing or the question has no admitted research sources.
- Webhooks: not required.
- Platform credentials: `SUPABASE_URL` and `SUPABASE_ANON_KEY` must be injected. Do not copy another project's values. The service role is not used.

The function posts to `https://api.x.ai/v1/chat/completions` with model `grok-4.7`, `temperature` 0, and `response_format.type` `json_object`. If the live API rejects those fields, fix the request from the returned error. Do not substitute a probability.

## Server secrets to enter through settings

| Name | Consumer | Required / optional | Owner source |
|---|---|---|---|
| `XAI_API_KEY` | `forecast` | Optional for the demo and the scoreboard. Required for a live forecast. | xAI console API key. SpaceXAI uses this name and `https://api.x.ai/v1`. |
| `SUPABASE_URL` | `forecast` | Required for the function to query as the user. | Platform-injected. |
| `SUPABASE_ANON_KEY` | `forecast` | Required for the function to query as the user. | Platform-injected. |

Missing-secret behavior: HTTP 503 `{ "error": "missing_secret", "message": "Set the server secret XAI_API_KEY. The function will not invent a probability." }`.

Only `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` belong in the frontend env. `XAI_API_KEY` must not use a `VITE_` prefix.

## Auth, storage, and external steps

- Auth providers/confirmation: email and password. The UI uses `signInWithPassword` and `signUp`. Confirmation, if enabled, must be completed before a session exists. No other providers.
- Site URL and callback/recovery routes: set the Site URL to the hosted origin when hosting is chosen. The app has no separate recovery route; use the platform's reset flow if it is enabled later.
- Buckets: not required.
- Realtime: not required.
- Scheduled/long jobs: not required. Scoring runs in the browser. A live forecast is a single request, not a worker.
- Outside services: an xAI account and `XAI_API_KEY` for live forecasts. No search provider, no market API, no wallet.
- Real integrations: SpaceXAI chat completions inside `forecast`, only after the secret is set. Explicit demos: the Harbor fixture and recorded probabilities in `src/lib/demoPack.ts`. Those numbers are not model output.

## Acceptance checks and receipts

Use synthetic data. Every row below is pending.

| Check | Expected result | Outcome / receipt |
|---|---|---|
| Import/install/build | `npm ci` (after a lockfile exists) and `npm run build` succeed | pending |
| Schema | `20261023150000_study.sql` is the only applied migration and the six tables exist | pending |
| Function round trip | A signed-in call to `forecast` returns the JSON contract | pending |
| Auth/isolation | No session cannot read rows. User B cannot read or write user A's set. | pending |
| Missing secret | `forecast` returns 503 `missing_secret` and stores nothing | pending |
| Uploads, if needed | Not required | not required |
| Webhooks, if needed | Not required | not required |
| Jobs, if needed | Not required | not required |
| Publish, if requested | Not requested | not requested |
| Unit tests | `npm test` covers Brier, the critic, leakage, the prompt pack, and the Harbor market comparison | pending; tests were not executed |
| Invalid model body | A non-numeric probability stores nothing | pending |

## One prompt after GitHub import

### Inspect and prepare only

> Read BOLT-HANDOFF.md and inspect the imported source at the intended branch. Compare the Bolt Database inventory with `supabase/migrations/20261023150000_study.sql`, `supabase/functions/forecast/index.ts`, and `supabase/functions/_shared/engine.ts`. Report concrete deployment gaps and owner steps. Preserve the app. The browser demo must keep working when the public Supabase env is empty, and a missing `XAI_API_KEY` must stay an error rather than a made-up probability. Prepare a reviewable setup plan with those file names and the pending checks in this handoff. Do not create or change cloud resources, apply migrations, deploy functions, enter secrets, or publish. Do not describe this Dirty Mode source as runtime-verified.
