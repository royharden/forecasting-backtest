import { useEffect, useMemo, useState } from "react";
import {
  appendVerdict,
  buildBundle,
  createAuditSample,
  importManifest,
  importManifestText,
  LIMITS,
  type ImportIssue,
  type ImportResult,
} from "../supabase/functions/_shared/engine.ts";
import { AccountPanel } from "./components/AccountPanel";
import { AttemptInspector } from "./components/AttemptInspector";
import { AuditPanel } from "./components/AuditPanel";
import { AuthBar } from "./components/AuthBar";
import { BundlePanel } from "./components/BundlePanel";
import { EvidencePanel } from "./components/EvidencePanel";
import { ProtocolCard } from "./components/ProtocolCard";
import { Scoreboard } from "./components/Scoreboard";
import { Workshop } from "./components/Workshop";
import { readPublicConfig } from "./lib/config";
import { harborManifestValue } from "./lib/demoPack";
import { messageOf, shortHash } from "./lib/labels";
import { appendAuditVerdictRemote, createAuditSampleRemote } from "./lib/repository";
import { downloadJson, nowUtc, readFileText, runRecordedReplay, type LoadedDataset, type RunRecord } from "./lib/session";
import { getSupabase } from "./lib/supabaseClient";

export function App() {
  const configured = readPublicConfig() != null;
  const [email, setEmail] = useState<string | null>(null);
  const [dataset, setDataset] = useState<LoadedDataset | null>(null);
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string>("");
  const [banner, setBanner] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const supabase = getSupabase();
    if (supabase == null) return;
    let active = true;
    void supabase.auth.getSession().then(({ data }) => {
      if (active) setEmail(data.session?.user.email ?? null);
    });
    const { data } = supabase.auth.onAuthStateChange((_event, session) => setEmail(session?.user.email ?? null));
    return () => {
      active = false;
      data.subscription.unsubscribe();
    };
  }, []);

  const datasetRuns = useMemo(() => runs.filter((r) => r.manifest.datasetVersionHash === dataset?.version.versionHash), [runs, dataset]);
  const activeRun = datasetRuns.find((r) => r.manifest.runId === activeRunId) ?? null;
  const questions = dataset?.version.questions ?? [];
  const selected = questions.find((q) => q.id === selectedId) ?? questions.find((q) => q.role === "evaluation") ?? null;
  const selectedExecution = activeRun?.execution.items.find((i) => i.questionId === selected?.id) ?? null;

  function adopt(result: ImportResult, source: LoadedDataset["source"], storedVersionId: string | null = null): ImportIssue[] | null {
    if (!result.ok) return result.errors;
    setDataset({ version: result.version, recordings: result.recordings, recordingsHash: result.recordingsHash, source, warnings: result.warnings, storedVersionId });
    setSelectedId(result.version.questions.find((q) => q.role === "evaluation")?.id ?? "");
    setActiveRunId(null);
    setBanner(null);
    return null;
  }

  function enterDemo() {
    const errors = adopt(importManifest(harborManifestValue(), nowUtc()), "demo");
    if (errors != null) setBanner(`The bundled demo failed validation: ${errors.map((e) => `${e.path} ${e.code}`).join("; ")}`);
  }

  function addRun(run: RunRecord) {
    setRuns((current) => [...current.filter((r) => r.manifest.runId !== run.manifest.runId), run]);
    setActiveRunId(run.manifest.runId);
  }

  function patchRun(runId: string, patch: Partial<RunRecord>) {
    setRuns((current) => current.map((r) => (r.manifest.runId === runId ? { ...r, ...patch } : r)));
  }

  async function guarded(action: () => Promise<void>) {
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

  function keptPopulation(run: RunRecord) {
    return run.execution.items.flatMap((item) =>
      item.gate.ledger.filter((d) => d.decision === "kept").map((d) => ({ questionId: d.questionId, evidenceId: d.evidenceId })),
    );
  }

  return (
    <main className="app">
      <header className="topbar">
        <h1>Forecasting backtest</h1>
        <p className="lede">
          A supplied-evidence backtest for already resolved yes/no questions. It compares a researched forecast with no-research, market-as-of, training base-rate and
          always-0.5 arms under a frozen cutoff protocol. No trading, no live questions, no investment advice. Retrieval from the web is not implemented.
        </p>
      </header>
      <AuthBar configured={configured} email={email} />
      {banner != null ? (
        <p className="banner" role="status">
          {banner}
        </p>
      ) : null}

      <section className="panel toolbar" aria-label="Load data">
        <button type="button" disabled={busy} onClick={enterDemo}>
          Enter synthetic demo
        </button>
        <label>
          Import manifest v1 (JSON, ≤ 1 MiB)
          <input
            type="file"
            accept="application/json,.json"
            disabled={busy}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file == null) return;
              void guarded(async () => {
                const text = await readFileText(file, LIMITS.importBytes);
                const errors = adopt(importManifestText(text, nowUtc()), "import");
                if (errors != null) throw new Error(`Import failed; nothing was loaded. ${errors.slice(0, 8).map((e) => `${e.path} ${e.code}: ${e.message}`).join(" | ")}`);
              });
            }}
          />
        </label>
        <p className="note">
          {configured && email != null
            ? "Signed in: use the account panel to store versions and runs privately."
            : "Browser session only: loaded data and runs last for this page session and are gone on reload."}
        </p>
      </section>

      {dataset != null ? (
        <>
          <ProtocolCard version={dataset.version} warnings={dataset.warnings} source={dataset.source} />
          <div className="layout">
            <aside className="panel" aria-label="Questions">
              <h2>Questions</h2>
              <div className="question-list">
                {questions.map((q) => (
                  <button type="button" key={q.id} aria-current={q.id === selected?.id ? "true" : undefined} onClick={() => setSelectedId(q.id)}>
                    <strong>{q.id}</strong> {q.role === "training" ? "(training)" : ""} {q.status === "quarantined" ? "(quarantined)" : ""}
                    <br />
                    <small>{q.questionTextAsOf}</small>
                  </button>
                ))}
              </div>
            </aside>
            <div>
              {selected != null && selected.role === "evaluation" ? <EvidencePanel version={dataset.version} question={selected} /> : null}
              {selected != null && selected.role === "training" ? (
                <section className="panel">
                  <h2>Training item {selected.id}</h2>
                  <p className="note">
                    Training items feed only the base rate: category {selected.category}, cluster {selected.eventClusterId}, resolved {selected.resolvedAt}.
                  </p>
                </section>
              ) : null}

              <section className="panel" aria-labelledby="runs-heading">
                <h2 id="runs-heading">Runs</h2>
                <p className="note">
                  Recorded replay runs the stored outputs through the same gate, critic, correction and audit rules. It has no model call path; a missing recording is a replay
                  miss.
                </p>
                <button
                  type="button"
                  disabled={busy || dataset.recordings.length === 0}
                  onClick={() => {
                    const result = runRecordedReplay(dataset);
                    if (!result.ok) setBanner(result.message);
                    else addRun(result.run);
                  }}
                >
                  Run recorded replay
                </button>
                {dataset.recordings.length === 0 ? <span className="note"> This dataset has no recorded attempts.</span> : null}
                {datasetRuns.length > 0 ? (
                  <ul>
                    {datasetRuns.map((r) => (
                      <li key={r.manifest.runId}>
                        <button type="button" className="linkish" aria-current={r.manifest.runId === activeRunId ? "true" : undefined} onClick={() => setActiveRunId(r.manifest.runId)}>
                          {r.manifest.mode} run {r.manifest.runId.slice(0, 8)} · {r.manifest.createdAt} · metrics {shortHash(r.report.metricsHash)}
                          {r.storedRunId != null ? " · stored" : " · page session only"}
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </section>

              <AccountPanel configured={configured} signedIn={email != null} dataset={dataset} busy={busy} guarded={guarded} onDatasetStored={setDataset} onRun={addRun} />

              {activeRun != null ? (
                <>
                  <Scoreboard report={activeRun.report} onSelect={setSelectedId} />
                  {selectedExecution != null && selected != null ? (
                    <AttemptInspector manifest={activeRun.manifest} execution={selectedExecution} questionOpensAt={selected.opensAt} />
                  ) : (
                    <p className="panel note">Select an eligible evaluation question to inspect its model arms.</p>
                  )}
                  <AuditPanel
                    version={dataset.version}
                    sample={activeRun.auditSample}
                    editions={activeRun.editions}
                    busy={busy}
                    onCreate={(requestedN, seed) =>
                      void guarded(async () => {
                        if (activeRun.execution.status !== "completed") throw new Error("Audit samples need a completed run; this run is partial or still processing.");
                        const sample =
                          activeRun.storedRunId != null
                            ? await createAuditSampleRemote(activeRun.storedRunId, dataset.version.versionHash, requestedN, seed, activeRun.execution)
                            : createAuditSample(activeRun.manifest.runId, dataset.version.versionHash, keptPopulation(activeRun), requestedN, seed);
                        patchRun(activeRun.manifest.runId, { auditSample: sample, editions: [] });
                      })
                    }
                    onVerdict={(sampleItemId, verdict, notes) =>
                      void guarded(async () => {
                        const sample = activeRun.auditSample;
                        if (sample == null) return;
                        const latest = activeRun.editions.filter((e) => e.sampleItemId === sampleItemId).sort((a, b) => b.edition - a.edition)[0];
                        if (activeRun.storedRunId != null) {
                          const editions = await appendAuditVerdictRemote(sample, sampleItemId, verdict, notes, latest?.editionId ?? null);
                          patchRun(activeRun.manifest.runId, { editions });
                          return;
                        }
                        const result = appendVerdict(sample, activeRun.editions, {
                          sampleItemId,
                          verdict,
                          notes,
                          supersedesId: latest?.editionId ?? null,
                          createdAt: nowUtc(),
                          editionId: crypto.randomUUID(),
                        });
                        if (!result.ok) throw new Error(`Verdict not appended: ${result.code}`);
                        patchRun(activeRun.manifest.runId, { editions: result.editions });
                      })
                    }
                  />
                </>
              ) : null}
            </div>
          </div>
        </>
      ) : (
        <p className="panel note">
          Choose <strong>Enter synthetic demo</strong> to load six fictional resolved Harbor questions, or import a manifest v1 file. Synthetic results demonstrate arithmetic
          and control flow only.
        </p>
      )}

      <BundlePanel
        canExport={activeRun != null && dataset != null}
        onExport={() => {
          if (activeRun == null || dataset == null) return;
          const bundle = buildBundle(dataset.version, activeRun.manifest, activeRun.execution, activeRun.report, { sample: activeRun.auditSample, editions: activeRun.editions }, nowUtc());
          downloadJson(`s14-bundle-${activeRun.manifest.runId.slice(0, 8)}.json`, bundle);
        }}
      />

      <Workshop busy={busy} onFreeze={(text) => adopt(importManifestText(text, nowUtc()), "import")} />
    </main>
  );
}
