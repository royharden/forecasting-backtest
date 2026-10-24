import { useState } from "react";
import {
  auditRates,
  currentVerdicts,
  type AuditSample,
  type DatasetVersion,
  type Verdict,
  type VerdictEdition,
} from "../../supabase/functions/_shared/engine.ts";
import { formatScore } from "../lib/labels";

type AuditPanelProps = {
  version: DatasetVersion;
  sample: AuditSample | null;
  editions: VerdictEdition[];
  busy: boolean;
  onCreate: (requestedN: number, seed: number) => void;
  onVerdict: (sampleItemId: string, verdict: Exclude<Verdict, "unreviewed">, notes: string) => void;
};

export function AuditPanel({ version, sample, editions, busy, onCreate, onVerdict }: AuditPanelProps) {
  const [requestedN, setRequestedN] = useState(4);
  const [seed, setSeed] = useState(14);
  const [notes, setNotes] = useState("");
  const verdicts = sample == null ? new Map<string, Verdict>() : currentVerdicts(sample, editions);
  const rates = sample == null ? null : auditRates(sample, editions);
  return (
    <section className="panel" aria-labelledby="audit-heading">
      <h2 id="audit-heading">Human audit of kept evidence</h2>
      <p className="note">
        {version.kind === "synthetic"
          ? "Synthetic demonstration of the audit workflow: N/A as evidence of real leak detection."
          : "Samples supplied evidence for leaks. It cannot prove that no leak exists and never changes frozen scores; confirmed leaks create a separate sensitivity result."}
      </p>
      {sample == null ? (
        <form
          className="row"
          onSubmit={(event) => {
            event.preventDefault();
            onCreate(requestedN, seed);
          }}
        >
          <label>
            Sample size
            <input type="number" min={1} max={500} value={requestedN} onChange={(event) => setRequestedN(Number(event.target.value))} />
          </label>
          <label>
            Seed (nonzero)
            <input type="number" min={1} max={4294967295} value={seed} onChange={(event) => setSeed(Number(event.target.value))} />
          </label>
          <button type="submit" disabled={busy || !Number.isInteger(requestedN) || requestedN < 1 || !Number.isInteger(seed) || seed < 1}>
            Draw fixed sample
          </button>
        </form>
      ) : (
        <>
          <p>
            Reviewed {rates?.reviewedK} of {sample.sampledN} sampled from N={sample.populationN} kept sources; {rates?.unreviewed} unreviewed. Leak rate{" "}
            {rates?.leakRate == null ? "unavailable (k=0)" : formatScore(rates.leakRate)}; leak-or-unsure{" "}
            {rates?.leakOrUnsureRate == null ? "unavailable (k=0)" : formatScore(rates.leakOrUnsureRate)}. Judge agreement N/A (no judge).
          </p>
          <p className="note">
            Sample fixed by {sample.algorithm}, seed {sample.seed}, requested {sample.requestedN}; selection hash {sample.selectionHash.slice(0, 12)}…
          </p>
          <label>
            Note for the next verdict
            <input value={notes} onChange={(event) => setNotes(event.target.value)} maxLength={500} />
          </label>
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Source</th>
                  <th>Excerpt</th>
                  <th>Current verdict</th>
                  <th>Append verdict</th>
                </tr>
              </thead>
              <tbody>
                {sample.items.map((item) => {
                  const row = version.evidence.find((e) => e.id === item.evidenceId);
                  const history = editions.filter((e) => e.sampleItemId === item.sampleItemId).length;
                  return (
                    <tr key={item.sampleItemId}>
                      <td>{item.position + 1}</td>
                      <td>
                        {item.questionId} / {item.evidenceId}
                      </td>
                      <td>{row?.excerpt ?? "(redacted)"}</td>
                      <td>
                        {verdicts.get(item.sampleItemId)}
                        {history > 1 ? <small> ({history} editions)</small> : null}
                      </td>
                      <td>
                        {(["clean", "leak", "unsure"] as const).map((verdict) => (
                          <button key={verdict} type="button" className="quiet" disabled={busy} onClick={() => onVerdict(item.sampleItemId, verdict, notes)}>
                            {verdict}
                          </button>
                        ))}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
