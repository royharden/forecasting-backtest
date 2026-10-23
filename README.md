# Forecasting backtest

A study bench for **already-resolved yes/no questions**. You set a forecast cutoff that is earlier than the resolution, keep only sources published by that cutoff, and score five arms. The market price at the cutoff is the bar. A backtest where the model loses to the market is a valid result.

This copy was built in Dirty Mode. The source is written. Install, unit tests, the production build, the database, and the live model call have **not** been run.

## Demo, before any account

With `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` unset, the app stays in the browser and loads the fictional Harbor set. Nothing is stored and no model is called.

On that set the scoreboard is meant to show:

- the market arm scoring all six questions
- the research arm scoring five, because the Ashpier question's only claim cites a source published after resolution
- a model-memory flag on the Pier 4 question, which is still scored
- a lower market Brier than the recorded no-research arm, the recorded research arm, and always-0.5

Those recorded probabilities are fixture data, not live model output.

## Rules

A source is admitted only when it has a published time at or before the cutoff.

A claim is admitted only when it cites an admitted source whose text does not contain the question's resolution sentence. Claims with no source, an undated source, or a later source are rejected. That critic is a rule, not a second model.

Arms:

| Arm | Probability | When it is withheld |
|---|---|---|
| Market price | Stored YES price at the cutoff | Question cutoff is not before resolution, or the price is outside 0 to 1 |
| Base rate | YES rate among other questions in the set that had already resolved by this cutoff | No such question |
| Always 0.5 | 0.5 | Same question-level exclusion as the market |
| No research | Latest forecast made from the question text alone | Missing, out of range, or the rationale contains the resolution sentence |
| Research | Latest forecast that cites claims | Same checks, plus no admitted claim |

A missing model forecast is left missing. It is not rewritten to 0.5. Always-0.5 is its own arm.

Scores are Brier, log loss (probabilities are clipped only inside the log), Brier skill against always-0.5 on the questions that arm actually scored, a 10-bin reliability diagram, ECE, and the Murphy split on those bins. The Murphy split matches the binned Brier, which can differ from the raw Brier.

The live prompt includes the question text, the cutoff, and admitted sources. It does not include the outcome, the resolution sentence, or the market price. Research prompts are limited to 20 sources and 4,000 characters of body each.

## Live forecast

Sign in, store the set, and use **Generate live forecast**. The browser calls the `forecast` edge function with the user session. The function calls SpaceXAI (`grok-4.7` at `https://api.x.ai/v1/chat/completions`) only when the server secret `XAI_API_KEY` is set. If that secret is missing, the function returns `missing_secret` and does not invent a probability. A response that is not a probability from 0 to 1 is rejected and not stored.

The account cap is 20 live forecasts per hour. The count-then-call check is not a transaction.

## Stack

React, TypeScript, and Vite. Optional Bolt Database via `supabase-js`. One SQL migration. One Deno edge function. The pure rules live in `supabase/functions/_shared/engine.ts` so the page and the function share them.

## Later setup

These commands have not been run in this construction pass:

```bash
npm install
npm test
npm run typecheck
npm run dev
npm run build
```

Copy `.env.example` to `.env.local` and fill only the two public names after Bolt creates a database. Put `XAI_API_KEY` in server secrets, never in a `VITE_` name.

See `BOLT-HANDOFF.md` for the provisioning inventory. Infrastructure is pending.

## What has not run

- Dependency install and the lockfile
- Vitest, `tsc`, and the Vite build
- Migration apply and row-level security with two users
- Auth email settings
- Deploy and invoke of `forecast`
- A real `grok-4.7` response
- Browser use of the screens

A failed check, once run, is a failure. Do not treat this README as a test receipt.
