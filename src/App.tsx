import { useEffect, useMemo, useState } from "react";
import type { ModelArm, QuestionRecord, StudySet } from "../supabase/functions/_shared/engine.ts";
import { runBacktest } from "../supabase/functions/_shared/engine.ts";
import { AuthBar } from "./components/AuthBar";
import { Scoreboard } from "./components/Scoreboard";
import { Workshop } from "./components/Workshop";
import { demoStudy } from "./lib/demoPack";
import { isUuid, messageOf } from "./lib/labels";
import { requestLiveForecast } from "./lib/liveForecast";
import { readPublicConfig } from "./lib/config";
import {
  createEmptySet,
  deleteSet,
  deleteClaim,
  deleteSource,
  insertClaim,
  insertForecast,
  insertQuestion,
  insertRun,
  insertSource,
  listRuns,
  listSets,
  loadSet,
  renameSet,
  saveStudyCopy,
  updateQuestion,
  type RunSummary,
  type SetSummary,
} from "./lib/repository";
import {
  blankClaim,
  blankQuestion,
  blankSource,
  patchQuestion,
  recordedForecast,
  withoutClaim,
  withoutSource,
} from "./lib/studyEdit";
import { getSupabase } from "./lib/supabaseClient";

const initial = demoStudy();

export function App() {
  const configured = readPublicConfig() != null;
  const [email, setEmail] = useState<string | null>(null);
  const [study, setStudy] = useState<StudySet>(initial);
  const [selectedId, setSelectedId] = useState(initial.questions[0]?.id ?? "");
  const [sets, setSets] = useState<SetSummary[]>([]);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [banner, setBanner] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [hideMemoryRisk, setHideMemoryRisk] = useState(false);
  const account = email != null && isUuid(study.id);

  const fullReport = useMemo(() => runBacktest(study), [study]);
  const report = useMemo(() => {
    if (!hideMemoryRisk) return fullReport;
    const hidden = new Set(
      fullReport.questions
        .filter((question) => question.flags.some((flag) => flag.code === "model_memory_risk"))
        .map((question) => question.questionId),
    );
    return runBacktest({
      ...study,
      questions: study.questions.filter((question) => !hidden.has(question.id)),
    });
  }, [study, hideMemoryRisk, fullReport]);

  useEffect(() => {
    const supabase = getSupabase();
    if (supabase == null) return;
    let active = true;
    void supabase.auth.getSession().then(({ data }) => {
      if (active) setEmail(data.session?.user.email ?? null);
    });
    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      setEmail(session?.user.email ?? null);
    });
    return () => {
      active = false;
      data.subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (email != null || !isUuid(study.id)) return;
    const demo = demoStudy();
    setStudy(demo);
    setSelectedId(demo.questions[0]?.id ?? "");
    setRuns([]);
  }, [email, study.id]);

  useEffect(() => {
    if (email == null) {
      setSets([]);
      return;
    }
    let active = true;
    void listSets()
      .then((rows) => {
        if (active) setSets(rows);
      })
      .catch((error: unknown) => {
        if (active) setBanner(messageOf(error));
      });
    return () => {
      active = false;
    };
  }, [email]);

  useEffect(() => {
    if (email == null || !isUuid(study.id)) {
      setRuns([]);
      return;
    }
    let active = true;
    void listRuns(study.id)
      .then((rows) => {
        if (active) setRuns(rows);
      })
      .catch((error: unknown) => {
        if (active) setBanner(messageOf(error));
      });
    return () => {
      active = false;
    };
  }, [email, study.id]);

  const selected = study.questions.find((question) => question.id === selectedId) ?? study.questions[0] ?? null;
  const selectedReport = fullReport.questions.find((question) => question.questionId === selected?.id);

  async function runAction(action: () => Promise<void>) {
    setBusy(true);
    setBanner(null);
    try {
      await action();
    } catch (error: unknown) {
      setBanner(messageOf(error));
    } finally {
      setBusy(false);
    }
  }

  function patchSelected(patch: Partial<QuestionRecord>) {
    if (selected == null) return;
    setStudy((current) => patchQuestion(current, selected.id, patch));
  }

  return (
    <main className="app">
      <header className="topbar">
        <h1>Forecasting backtest</h1>
        <p className="lede">
          Score resolved yes/no questions as of a cutoff. Undated claims are rejected. The market price at that cutoff is the bar.
        </p>
      </header>
      <AuthBar configured={configured} email={email} />
      {banner != null ? (
        <p className="banner" role="status">
          {banner}
        </p>
      ) : null}
      <div className="panel toolbar">
        <label>
          Study set
          <select
            value={isUuid(study.id) ? study.id : "demo"}
            onChange={(event) => {
              const value = event.target.value;
              if (value === "demo") {
                const demo = demoStudy();
                setStudy(demo);
                setSelectedId(demo.questions[0]?.id ?? "");
                return;
              }
              void runAction(async () => {
                const loaded = await loadSet(value);
                setStudy(loaded);
                setSelectedId(loaded.questions[0]?.id ?? "");
              });
            }}
          >
            <option value="demo">Browser demo</option>
            {sets.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Name
          <input
            value={study.name}
            onChange={(event) => setStudy((current) => ({ ...current, name: event.target.value }))}
            onBlur={() => {
              if (!account || study.name.trim() === "") return;
              void runAction(() => renameSet(study.id, study.name.trim()));
            }}
          />
        </label>
        <button
          type="button"
          disabled={busy || email == null || isUuid(study.id)}
          onClick={() =>
            void runAction(async () => {
              const saved = await saveStudyCopy(study);
              setStudy(saved);
              setSelectedId(saved.questions[0]?.id ?? "");
              setSets(await listSets());
              setBanner("Stored a copy on your account.");
            })
          }
        >
          Store this set
        </button>
        <button
          type="button"
          className="quiet"
          disabled={busy || email == null}
          onClick={() =>
            void runAction(async () => {
              const created = await createEmptySet("Untitled study");
              setStudy(created);
              setSelectedId("");
              setSets(await listSets());
            })
          }
        >
          New empty set
        </button>
        <button
          type="button"
          className="quiet"
          disabled={busy || isUuid(study.id)}
          onClick={() => {
            const demo = demoStudy();
            setStudy(demo);
            setSelectedId(demo.questions[0]?.id ?? "");
          }}
        >
          Reload demo
        </button>
        <button
          type="button"
          className="quiet"
          disabled={busy || !account}
          onClick={() => {
            if (!window.confirm("Delete this stored study set?")) return;
            void runAction(async () => {
              await deleteSet(study.id);
              const demo = demoStudy();
              setStudy(demo);
              setSelectedId(demo.questions[0]?.id ?? "");
              setSets(await listSets());
            });
          }}
        >
          Delete stored set
        </button>
      </div>
      <div className="layout">
        <aside className="panel">
          <h2>Questions</h2>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              const draft = blankQuestion(study.id);
              void runAction(async () => {
                if (account) {
                  const saved = await insertQuestion(draft);
                  setStudy((current) => ({ ...current, questions: [...current.questions, saved] }));
                  setSelectedId(saved.id);
                  return;
                }
                setStudy((current) => ({ ...current, questions: [...current.questions, draft] }));
                setSelectedId(draft.id);
              });
            }}
          >
            Add question
          </button>
          <div className="question-list">
            {study.questions.map((question) => (
              <button
                type="button"
                key={question.id}
                aria-current={question.id === selected?.id ? "true" : undefined}
                onClick={() => setSelectedId(question.id)}
              >
                {question.prompt}
              </button>
            ))}
          </div>
        </aside>
        <div>
          <Scoreboard
            study={study}
            report={report}
            hideMemoryRisk={hideMemoryRisk}
            onToggleMemoryRisk={setHideMemoryRisk}
            onSelect={setSelectedId}
          />
          {selected == null ? (
            <p className="panel">This set has no questions yet.</p>
          ) : (
            <Workshop
              study={study}
              question={selected}
              report={selectedReport}
              account={account}
              busy={busy}
              onPatch={patchSelected}
              onStoreQuestion={() => {
                if (selected == null) return;
                const current = study.questions.find((question) => question.id === selected.id);
                if (current == null) return;
                void runAction(() => updateQuestion(current));
              }}
              onAddSource={(input) => {
                const source = {
                  ...blankSource(selected.id),
                  title: input.title,
                  url: input.url,
                  publishedAt: input.publishedAt === "" ? null : input.publishedAt,
                  body: input.body,
                };
                void runAction(async () => {
                  if (account) {
                    const saved = await insertSource(source);
                    setStudy((current) => ({ ...current, sources: [...current.sources, saved] }));
                    return;
                  }
                  setStudy((current) => ({ ...current, sources: [...current.sources, source] }));
                });
              }}
              onDeleteSource={(sourceId) =>
                void runAction(async () => {
                  if (account) await deleteSource(sourceId);
                  setStudy((current) => withoutSource(current, sourceId));
                })
              }
              onAddClaim={(text, sourceId) => {
                const claim = { ...blankClaim(selected.id, sourceId), text };
                void runAction(async () => {
                  if (account) {
                    const saved = await insertClaim(claim);
                    setStudy((current) => ({ ...current, claims: [...current.claims, saved] }));
                    return;
                  }
                  setStudy((current) => ({ ...current, claims: [...current.claims, claim] }));
                });
              }}
              onDeleteClaim={(claimId) =>
                void runAction(async () => {
                  if (account) await deleteClaim(claimId);
                  setStudy((current) => withoutClaim(current, claimId));
                })
              }
              onStoreRecorded={(arm: ModelArm, probability: number, rationale: string) => {
                const claimIds = study.claims.filter((claim) => claim.questionId === selected.id).map((claim) => claim.id);
                const forecast = recordedForecast({ questionId: selected.id, arm, probability, rationale, claimIds });
                void runAction(async () => {
                  if (account) {
                    const saved = await insertForecast(forecast);
                    setStudy((current) => ({ ...current, forecasts: [...current.forecasts, saved] }));
                    return;
                  }
                  setStudy((current) => ({ ...current, forecasts: [...current.forecasts, forecast] }));
                });
              }}
              onLive={(arm) =>
                void runAction(async () => {
                  const result = await requestLiveForecast(selected.id, arm);
                  setStudy((current) => ({
                    ...current,
                    claims: [...current.claims, ...result.claims],
                    forecasts: [...current.forecasts, result.forecast],
                  }));
                  setBanner(result.message);
                })
              }
            />
          )}
          <section className="panel">
            <h2>Saved runs</h2>
            <button
              type="button"
              disabled={busy || !account}
              onClick={() =>
                void runAction(async () => {
                  await insertRun(study.id, `${study.name} ${new Date().toISOString()}`, report);
                  setRuns(await listRuns(study.id));
                  setBanner("Saved the current scoreboard. The board itself always recomputes.");
                })
              }
            >
              Save this scoreboard
            </button>
            {runs.length === 0 ? <p className="note">No stored snapshots for this set.</p> : null}
            <ul>
              {runs.map((run) => (
                <li key={run.id}>
                  {run.label} ({run.createdAt})
                </li>
              ))}
            </ul>
          </section>
        </div>
      </div>
    </main>
  );
}
