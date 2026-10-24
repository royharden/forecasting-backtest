import { useState } from "react";
import type { ArmSummary, CalibrationBin, PairedComparison, RunReport } from "../../supabase/functions/_shared/engine.ts";
import { formatScore, formatSigned, reasonLabel } from "../lib/labels";

type ScoreboardProps = {
  report: RunReport;
  onSelect: (questionId: string) => void;
};

type ArmKey = "policyAll" | "market" | "baseRate" | "half" | "noResearch" | "research";

export function Scoreboard({ report, onSelect }: ScoreboardProps) {
  const [chartArm, setChartArm] = useState<ArmKey>("policyAll");
  const summaries: Record<ArmKey, ArmSummary> = {
    policyAll: report.policy.all,
    market: report.arms.market,
    baseRate: report.arms.baseRate,
    half: report.arms.half,
    noResearch: report.arms.noResearch,
    research: report.arms.research,
  };
  return (
    <section className="panel" aria-labelledby="score-heading">
      <h2 id="score-heading">Scores</h2>
      <p className="banner" role="note">
        {report.caution}
      </p>
      <Comparison comparison={report.primary} primary />
      <p className="note">
        Eligible questions: {report.eligibleN}. Market price missing for {report.marketMissingN} ({formatCounts(report.reasonCounts.market)}). Policy tiers:{" "}
        research {report.policy.tierCounts.research}, no-research fallback {report.policy.tierCounts.no_research}, 0.5 fallback{" "}
        {report.policy.tierCounts.half}. Within the market-paired cohort: research {report.policy.tierCountsMarketPaired.research}, no-research{" "}
        {report.policy.tierCountsMarketPaired.no_research}, 0.5 {report.policy.tierCountsMarketPaired.half}. The policy score is not an imputed research forecast.
      </p>
      <h3>Policy and arms (each on its own available cohort)</h3>
      <div className="scroll">
        <table>
          <thead>
            <tr>
              <th>Forecast</th>
              <th>n</th>
              <th>Brier</th>
              <th>Skill vs 0.5 (same IDs)</th>
              <th>IDs</th>
            </tr>
          </thead>
          <tbody>
            {[report.policy.all, report.policy.marketPaired, report.arms.market, report.arms.baseRate, report.arms.half, report.arms.noResearch, report.arms.research].map((s) => (
              <tr key={s.label}>
                <td>{s.label}</td>
                <td>{s.n}</td>
                <td>{formatScore(s.brier)}</td>
                <td>{formatScore(s.skillVsHalf)}</td>
                <td>
                  <small>{s.ids.join(", ") || "none"}</small>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="note">
        Strict research is conditional on valid supported outputs ({report.arms.research.n} of {report.eligibleN}). Reasons: {formatCounts(report.reasonCounts.research, true)}. No
        research: {formatCounts(report.reasonCounts.noResearch, true)}. Base rate: {formatCounts(report.reasonCounts.baseRate, true)}.
      </p>
      <Comparison comparison={report.secondary} />
      <details>
        <summary>Complete-case table (secondary diagnostic)</summary>
        <p className="note">
          Only questions where all five arms have a value: {report.cohorts.completeCase.length === 0 ? "none" : report.cohorts.completeCase.join(", ")}. Conditional selection
          warning: these questions are not a random subset.
        </p>
        <SummaryTable rows={Object.values(report.completeCase)} />
      </details>
      <details>
        <summary>Secondary metrics: log loss, ECE, binned Murphy</summary>
        <p className="note">Log loss clips probabilities at 1e-6. Binned Murphy equals the binned Brier, not the raw Brier when forecasts vary inside a bin.</p>
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>Forecast</th>
                <th>n</th>
                <th>Log loss</th>
                <th>ECE</th>
                <th>Reliability</th>
                <th>Resolution</th>
                <th>Uncertainty</th>
                <th>Binned Brier</th>
              </tr>
            </thead>
            <tbody>
              {Object.values(summaries).map((s) => (
                <tr key={s.label}>
                  <td>{s.label}</td>
                  <td>{s.n}</td>
                  <td>{formatScore(s.logLoss)}</td>
                  <td>{formatScore(s.ece)}</td>
                  <td>{formatScore(s.murphy?.reliability)}</td>
                  <td>{formatScore(s.murphy?.resolution)}</td>
                  <td>{formatScore(s.murphy?.uncertainty)}</td>
                  <td>{formatScore(s.murphy?.binnedBrier)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
      <h3>Calibration</h3>
      <label>
        Forecast
        <select value={chartArm} onChange={(event) => setChartArm(event.target.value as ArmKey)}>
          {(Object.keys(summaries) as ArmKey[]).map((key) => (
            <option key={key} value={key}>
              {summaries[key].label}
            </option>
          ))}
        </select>
      </label>
      <CalibrationView bins={summaries[chartArm].bins} />
      <h3>Per question</h3>
      <div className="scroll">
        <table>
          <thead>
            <tr>
              <th>Question</th>
              <th>Outcome</th>
              <th>Market</th>
              <th>Base rate</th>
              <th>No research</th>
              <th>Research</th>
              <th>Policy (tier)</th>
            </tr>
          </thead>
          <tbody>
            {report.items.map((item) => (
              <tr key={item.questionId}>
                <td>
                  <button type="button" className="linkish" onClick={() => onSelect(item.questionId)}>
                    {item.questionId}
                  </button>
                </td>
                <td>{item.outcome === 1 ? "Yes" : "No"}</td>
                <td>{item.market.probability != null ? formatScore(item.market.probability, 2) : reasonLabel(item.market.status)}</td>
                <td>{item.baseRate.probability != null ? formatScore(item.baseRate.probability, 2) : reasonLabel(item.baseRate.status)}</td>
                <td>{item.noResearch.probability != null ? formatScore(item.noResearch.probability, 2) : reasonLabel(item.noResearch.reasonCode)}</td>
                <td>
                  {item.research.probability != null ? formatScore(item.research.probability, 2) : reasonLabel(item.research.reasonCode)}
                  {item.research.withheldProbability != null ? <small> (unscored p {formatScore(item.research.withheldProbability, 2)})</small> : null}
                </td>
                <td>
                  {formatScore(item.policy.probability, 2)} ({item.policy.tier})
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Comparison({ comparison, primary = false }: { comparison: PairedComparison; primary?: boolean }) {
  return (
    <div className={primary ? "headline" : "note"}>
      <p>
        <strong>{comparison.label}</strong>: {comparison.meanDifference == null ? "no paired questions" : formatSigned(comparison.meanDifference)} on n={comparison.n} paired
        question(s) in {comparison.clusterCount} cluster(s). Negative favours the first forecast.
      </p>
      <p className="note">
        {comparison.interval != null
          ? `95% interval [${formatSigned(comparison.interval.lower)}, ${formatSigned(comparison.interval.upper)}] (seed ${comparison.interval.seed}, B=${comparison.interval.replicates}, ${comparison.interval.clusterCount} clusters). `
          : ""}
        {comparison.intervalNote}
      </p>
    </div>
  );
}

function SummaryTable({ rows }: { rows: ArmSummary[] }) {
  return (
    <div className="scroll">
      <table>
        <thead>
          <tr>
            <th>Forecast</th>
            <th>n</th>
            <th>Brier</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => (
            <tr key={s.label}>
              <td>{s.label}</td>
              <td>{s.n}</td>
              <td>{formatScore(s.brier)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function formatCounts(counts: Record<string, number>, labelled = false): string {
  const entries = Object.entries(counts);
  if (entries.length === 0) return "none";
  return entries.map(([code, n]) => `${labelled ? reasonLabel(code) : code} ${n}`).join(", ");
}

/** Calibration points for occupied bins only (no empty plotted points) plus the full count table. */
function CalibrationView({ bins }: { bins: CalibrationBin[] }) {
  const occupied = bins.filter((bin) => bin.count > 0);
  const size = 300;
  const pad = 34;
  const plot = size - pad * 2;
  const xOf = (v: number) => pad + v * plot;
  const yOf = (v: number) => pad + (1 - v) * plot;
  return (
    <div className="calibration">
      {occupied.length === 0 ? (
        <p className="note">No scored forecasts for this selection, so there is no calibration plot.</p>
      ) : (
        <svg className="chart" width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label="Calibration: mean forecast against YES fraction per bin">
          <line x1={xOf(0)} y1={yOf(0)} x2={xOf(1)} y2={yOf(1)} stroke="#c9bfae" strokeDasharray="4 4" />
          <line x1={xOf(0)} y1={yOf(0)} x2={xOf(1)} y2={yOf(0)} stroke="#9c927f" />
          <line x1={xOf(0)} y1={yOf(0)} x2={xOf(0)} y2={yOf(1)} stroke="#9c927f" />
          {occupied.map((bin) => (
            <circle key={bin.index} cx={xOf(bin.meanProbability as number)} cy={yOf(bin.yesFraction as number)} r={4 + Math.min(bin.count, 6)} fill="#1f4d3a" fillOpacity="0.8">
              <title>
                Bin {bin.index}: n={bin.count}, mean p {formatScore(bin.meanProbability)}, YES fraction {formatScore(bin.yesFraction)}
              </title>
            </circle>
          ))}
          <text x={pad} y={size - 10} fontSize="11">
            0
          </text>
          <text x={size - pad - 6} y={size - 10} fontSize="11">
            1
          </text>
          <text x={size / 2 - 40} y={size - 10} fontSize="11">
            mean forecast
          </text>
          <text x={6} y={pad + 4} fontSize="11">
            1
          </text>
        </svg>
      )}
      <div className="scroll">
        <table>
          <thead>
            <tr>
              <th>Bin</th>
              <th>n</th>
              <th>Mean p</th>
              <th>YES fraction</th>
            </tr>
          </thead>
          <tbody>
            {bins.map((bin) => (
              <tr key={bin.index}>
                <td>
                  [{bin.lower.toFixed(2)}, {bin.upper.toFixed(2)}
                  {bin.index === bins.length - 1 ? "]" : ")"}
                </td>
                <td>{bin.count}</td>
                <td>{formatScore(bin.meanProbability)}</td>
                <td>{formatScore(bin.yesFraction)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
