import { useMemo } from "react";
import { gateForQuestion, type DatasetVersion, type FrozenQuestion } from "../../supabase/functions/_shared/engine.ts";
import { GATE_LABEL, safeHref } from "../lib/labels";

type EvidencePanelProps = {
  version: DatasetVersion;
  question: FrozenQuestion;
};

/** As-of wording, cutoff and the outcome-independent source decisions for one question. */
export function EvidencePanel({ version, question }: EvidencePanelProps) {
  const gate = useMemo(() => (question.status === "eligible" ? gateForQuestion(version, question) : null), [version, question]);
  const rows = version.evidence.filter((e) => e.questionId === question.id);
  return (
    <section className="panel" aria-labelledby="evidence-heading">
      <h2 id="evidence-heading">Question as of the cutoff</h2>
      <p>
        <strong>{question.questionTextAsOf}</strong>
      </p>
      <p className="note">Rules as of then: {question.resolutionRulesAsOf}</p>
      <dl className="facts">
        <dt>Opens</dt>
        <dd>{question.opensAt}</dd>
        <dt>Wording available</dt>
        <dd>
          {question.wordingAvailableAt} ({question.wordingVersionProof || "no proof"})
        </dd>
        <dt>Forecast cutoff</dt>
        <dd>
          {question.cutoffAt ?? "—"} ({question.cutoffProvenance})
        </dd>
        <dt>Evidence cutoff</dt>
        <dd>{question.evidenceCutoff ?? "—"}</dd>
        <dt>Category / cluster</dt>
        <dd>
          {question.category} / {question.eventClusterId}
        </dd>
        <dt>Status</dt>
        <dd>{question.status === "eligible" ? "Eligible" : `Quarantined: ${question.quarantineReasons.join(", ")}`}</dd>
      </dl>
      <p className="note">The outcome and resolution text are scoring/audit-only fields and are not shown here or sent to a model.</p>
      {gate != null ? (
        <p className="note">
          Funnel: {gate.funnel.raw} candidate(s) → {gate.funnel.kept} kept.{" "}
          {Object.entries(gate.funnel.drops)
            .filter(([, n]) => n > 0)
            .map(([reason, n]) => `${GATE_LABEL[reason as keyof typeof GATE_LABEL]} ${n}`)
            .join(" · ")}
          {gate.funnel.warnings > 0 ? ` · ${gate.funnel.warnings} warning(s), not counted as drops` : ""}
        </p>
      ) : null}
      <div className="scroll">
        <table>
          <thead>
            <tr>
              <th>Source</th>
              <th>Published</th>
              <th>Decision</th>
              <th>Excerpt</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const decision = gate?.ledger.find((d) => d.evidenceId === row.id);
              const href = safeHref(row.url);
              return (
                <tr key={row.id}>
                  <td>
                    {row.title}
                    <br />
                    <small>
                      {row.id} · {href != null ? <span title="Provenance URL; never fetched">{href}</span> : "no URL"}
                    </small>
                  </td>
                  <td>
                    {row.published.precision === "instant"
                      ? row.published.at
                      : row.published.precision === "day"
                        ? `${row.published.date} (date only)`
                        : row.published.precision === "interval"
                          ? `${row.published.start} – ${row.published.end}`
                          : "undated"}
                  </td>
                  <td>
                    {decision == null ? (
                      "—"
                    ) : (
                      <span className={decision.decision === "kept" ? "badge ok" : "badge bad"} title={decision.detail}>
                        {GATE_LABEL[decision.decision]}
                      </span>
                    )}
                    {decision?.warnings.map((w) => (
                      <span key={w} className="badge warn">
                        {w}
                      </span>
                    ))}
                  </td>
                  <td>{row.excerpt}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
