import { useEffect, useRef, useState } from "react";
import type { ModelProfile } from "../../supabase/functions/_shared/engine.ts";
import { shortHash } from "../lib/labels";
import { finalizeAsPartial, resumeOnAccount, runOnAccount } from "../lib/liveForecast";
import {
  fetchEnabledProfiles,
  finalizeDatasetRemote,
  listStoredRuns,
  listStoredVersions,
  loadStoredRun,
  loadStoredVersion,
  type StoredRunSummary,
  type StoredVersionSummary,
} from "../lib/repository";
import type { LoadedDataset, RunRecord } from "../lib/session";

type AccountPanelProps = {
  configured: boolean;
  signedIn: boolean;
  dataset: LoadedDataset;
  busy: boolean;
  guarded: (action: () => Promise<void>) => Promise<void>;
  onDatasetStored: (dataset: LoadedDataset) => void;
  onRun: (run: RunRecord) => void;
};

/** Private storage of versions and runs, and account replay/live runs through the forecast function. */
export function AccountPanel({ configured, signedIn, dataset, busy, guarded, onDatasetStored, onRun }: AccountPanelProps) {
  const [versions, setVersions] = useState<StoredVersionSummary[]>([]);
  const [runs, setRuns] = useState<StoredRunSummary[]>([]);
  const [profiles, setProfiles] = useState<ModelProfile[]>([]);
  const [progress, setProgress] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!configured || !signedIn) return;
    void guarded(async () => {
      setVersions(await listStoredVersions());
      setProfiles(await fetchEnabledProfiles());
    });
    // guarded is stable enough for a one-shot load per sign-in.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configured, signedIn]);

  useEffect(() => {
    if (!configured || !signedIn || dataset.storedVersionId == null) {
      setRuns([]);
      return;
    }
    const versionId = dataset.storedVersionId;
    void guarded(async () => setRuns(await listStoredRuns(versionId)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configured, signedIn, dataset.storedVersionId]);

  useEffect(() => () => abort.current?.abort(), []);

  if (!configured) return null;
  if (!signedIn) {
    return <p className="panel note">Sign in to store versions and runs privately on your account and to run through the server function.</p>;
  }

  // freeze_run requires the profile named by the frozen protocol card.
  const wanted = dataset.version.protocol.modelProfileVersion;
  const profile = profiles.find((p) => p.profileVersion === wanted) ?? null;

  async function withRun(action: (signal: AbortSignal) => Promise<RunRecord>) {
    abort.current = new AbortController();
    setRunning(true);
    try {
      onRun(await action(abort.current.signal));
      if (dataset.storedVersionId != null) setRuns(await listStoredRuns(dataset.storedVersionId));
    } finally {
      setRunning(false);
    }
  }

  return (
    <section className="panel" aria-labelledby="account-heading">
      <h2 id="account-heading">Account storage</h2>
      {dataset.storedVersionId == null ? (
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            void guarded(async () => {
              const id = await finalizeDatasetRemote(dataset);
              onDatasetStored({ ...dataset, storedVersionId: id });
              setVersions(await listStoredVersions());
            })
          }
        >
          Store this frozen version on my account
        </button>
      ) : (
        <p className="note">This version is stored ({shortHash(dataset.version.versionHash)}). Study edits create a new version; this one never changes.</p>
      )}
      {versions.length > 0 ? (
        <label>
          Open a stored version
          <select
            value=""
            disabled={busy}
            onChange={(event) => {
              const id = event.target.value;
              if (id === "") return;
              void guarded(async () => onDatasetStored(await loadStoredVersion(id)));
            }}
          >
            <option value="">Choose…</option>
            {versions.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name} ({v.kind}) · {v.frozenAt} · {shortHash(v.versionHash)}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {dataset.storedVersionId != null ? (
        <>
          <div className="row">
            <button type="button" disabled={busy || dataset.recordings.length === 0} onClick={() => void guarded(() => withRun((signal) => runOnAccount(dataset, "replay", null, setProgress, signal)))}>
              Run recorded replay on account
            </button>
            <button type="button" disabled={busy || profile == null} onClick={() => void guarded(() => withRun((signal) => runOnAccount(dataset, "live", profile, setProgress, signal)))} title={profile == null ? `Profile ${wanted} is not enabled` : undefined}>
              Run live forecasts
            </button>
            <button type="button" className="quiet" disabled={!running} onClick={() => abort.current?.abort()}>
              Pause
            </button>
          </div>
          <p className="note">
            {profile == null
              ? `Live forecasting is disabled: this version's protocol names model profile "${wanted}", which is not an enabled server profile. The owner must verify the model's training cutoff, pricing and token limits, set XAI_API_KEY and enable it.`
              : `Live profile ${profile.profileVersion} (${profile.modelId}), declared training cutoff ${profile.declaredTrainingCutoff ?? "unknown"}. Each arm uses at most 2 charged calls; daily and monetary caps apply on the server.`}
          </p>
          {progress != null ? <p className="note" role="status">{progress}</p> : null}
          {runs.length > 0 ? (
            <ul>
              {runs.map((r) => (
                <li key={r.id}>
                  <button type="button" className="linkish" disabled={busy} onClick={() => void guarded(async () => onRun(await loadStoredRun(r.id, dataset)))}>
                    Reopen {r.mode} run {r.id.slice(0, 8)} · {r.status} · {r.createdAt}
                  </button>
                  {r.status === "processing" || r.status === "created" ? (
                    <>
                      {" "}
                      <button type="button" className="quiet" disabled={busy} onClick={() => void guarded(() => withRun((signal) => resumeOnAccount(r.id, dataset, setProgress, signal)))}>
                        Resume
                      </button>{" "}
                      <button type="button" className="quiet" disabled={busy} onClick={() => void guarded(() => withRun(() => finalizeAsPartial(r.id, dataset)))}>
                        Finalize as partial
                      </button>
                    </>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
