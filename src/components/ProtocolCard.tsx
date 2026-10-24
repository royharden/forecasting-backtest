import type { DatasetVersion, ImportIssue } from "../../supabase/functions/_shared/engine.ts";
import { shortHash } from "../lib/labels";

type ProtocolCardProps = { version: DatasetVersion; warnings: ImportIssue[]; source: string };

export function ProtocolCard({ version, warnings, source }: ProtocolCardProps) {
  const p = version.protocol;
  const evaluation = version.questions.filter((q) => q.role === "evaluation");
  const training = version.questions.filter((q) => q.role === "training");
  return (
    <section className="panel" aria-labelledby="protocol-heading">
      <h2 id="protocol-heading">Frozen protocol</h2>
      <p className="note">
        {version.name} — {version.kind === "synthetic" ? "synthetic (fictional dates and outcomes)" : "real, owner-supplied"} · loaded from {source} · frozen{" "}
        {version.frozenAt}. Protocol and roles were fixed before any score was shown; any change creates a new exploratory version.
      </p>
      <dl className="facts">
        <dt>Version hash</dt>
        <dd title={version.versionHash}>{shortHash(version.versionHash)}</dd>
        <dt>Protocol</dt>
        <dd>
          {p.protocolId} ({shortHash(version.protocolHash)})
        </dd>
        <dt>Cutoff preset</dt>
        <dd>
          {p.cutoffPreset} — {p.cutoffSelectionNote}
        </dd>
        <dt>Source buffer</dt>
        <dd>{p.sourceBufferHours}h before the cutoff ({version.kind === "synthetic" ? "synthetic 0h" : "real 24h, never silently changed"})</dd>
        <dt>Market price</dt>
        <dd>last observation at or before cutoff, at most {p.maxPriceAgeHours}h old</dd>
        <dt>Base rate</dt>
        <dd>separate training cohort, n ≥ {p.trainMinimum} (category, else global, else unavailable)</dd>
        <dt>Arms and policy</dt>
        <dd>market, base rate, always 0.5, no research, strict research; policy {p.fallbackPolicy}</dd>
        <dt>Calibration</dt>
        <dd>{p.calibrationBins} bins</dd>
        <dt>Prompt evidence</dt>
        <dd>
          ≤ {p.maxPromptExcerpts} excerpts/question · {p.gateVersion} · {p.blocklistVersion} · {p.promptVersion}
        </dd>
        <dt>Questions</dt>
        <dd>
          {evaluation.length} evaluation · {training.length} training · {version.quarantine.length} quarantine row(s)
        </dd>
        <dt>Provenance</dt>
        <dd>{version.provenance}</dd>
        <dt>Rights</dt>
        <dd>{version.rights}</dd>
        <dt>Eligibility</dt>
        <dd>{p.eligibilityNote}</dd>
      </dl>
      {version.quarantine.length > 0 ? (
        <div className="scroll">
          <h3>Quarantine</h3>
          <table>
            <thead>
              <tr>
                <th>Target</th>
                <th>Reason</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {version.quarantine.map((row) => (
                <tr key={`${row.targetId}-${row.reason}`}>
                  <td>{row.targetId}</td>
                  <td>{row.reason}</td>
                  <td>{row.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="note">No quarantined questions.</p>
      )}
      {warnings.length > 0 ? (
        <ul>
          {warnings.map((w) => (
            <li key={`${w.path}-${w.code}`}>
              {w.path}: {w.message}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
