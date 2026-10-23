import { useState } from "react";
import type { ArmId, BacktestReport, CalibrationBin, StudySet } from "../../supabase/functions/_shared/engine.ts";
import { ARM_LABEL, formatScore } from "../lib/labels";

type ScoreboardProps = {
  study: StudySet;
  report: BacktestReport;
  hideMemoryRisk: boolean;
  onToggleMemoryRisk: (hide: boolean) => void;
  onSelect: (questionId: string) => void;
};

export function Scoreboard({ study, report, hideMemoryRisk, onToggleMemoryRisk, onSelect }: ScoreboardProps) {
  const [arm, setArm] = useState<ArmId>("market");
  const selected = report.arms.find((item) => item.arm === arm) ?? report.arms[0];
  const market = report.arms.find((item) => item.arm === "market");
  const research = report.arms.find((item) => item.arm === "research");
  const comparison =
    market?.brier != null && research?.brier != null
      ? market.brier < research.brier
        ? "On the questions each arm scored, the market price has a lower Brier than research."
        : "Research has a lower Brier than the market on the questions each arm scored. Check the counts before reading that as a win."
      : "One of those arms has no scored questions yet.";

  return (
    <section className="panel">
      <h2>Scoreboard</h2>
      <p className="note">
        Lower Brier is better. Skill is against an always-0.5 forecast on the same questions that arm scored. A missing model
        forecast stays missing. {comparison}
      </p>
      <label>
        <input
          type="checkbox"
          checked={hideMemoryRisk}
          onChange={(event) => onToggleMemoryRisk(event.target.checked)}
        />{" "}
        Hide questions flagged for model memory. Hiding one also removes it from the base rate.
      </label>
      <div className="scroll">
        <table>
          <thead>
            <tr>
              <th>Arm</th>
              <th>Scored</th>
              <th>Brier</th>
              <th>Log loss</th>
              <th>Skill vs 0.5</th>
              <th>ECE</th>
            </tr>
          </thead>
          <tbody>
            {report.arms.map((item) => (
              <tr key={item.arm}>
                <td>{ARM_LABEL[item.arm]}</td>
                <td>{item.count}</td>
                <td>{formatScore(item.brier)}</td>
                <td>{formatScore(item.logLoss)}</td>
                <td>{formatScore(item.brierSkillVsAlwaysHalf)}</td>
                <td>{formatScore(item.ece)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {selected?.murphy != null ? (
        <p className="note">
          {ARM_LABEL[selected.arm]} Murphy split on the ten probability bins: reliability {formatScore(selected.murphy.reliability)},
          resolution {formatScore(selected.murphy.resolution)}, uncertainty {formatScore(selected.murphy.uncertainty)}, binned Brier{" "}
          {formatScore(selected.murphy.binnedBrier)}. The binned Brier can differ from the raw Brier.
        </p>
      ) : null}
      <label>
        Calibration arm
        <select value={selected?.arm ?? "market"} onChange={(event) => setArm(event.target.value as ArmId)}>
          {report.arms.map((item) => (
            <option key={item.arm} value={item.arm}>
              {ARM_LABEL[item.arm]}
            </option>
          ))}
        </select>
      </label>
      <CalibrationChart bins={selected?.bins ?? []} />
      <div className="scroll">
        <table>
          <thead>
            <tr>
              <th>Question</th>
              <th>Outcome</th>
              {report.arms.map((item) => (
                <th key={item.arm}>{ARM_LABEL[item.arm]}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {report.questions.map((row) => {
              const question = study.questions.find((item) => item.id === row.questionId);
              return (
                <tr key={row.questionId}>
                  <td>
                    <button type="button" className="linkish" onClick={() => onSelect(row.questionId)}>
                      {question == null ? row.questionId : trimPrompt(question.prompt)}
                    </button>
                  </td>
                  <td>{row.eligible ? (question?.outcome ? "Yes" : "No") : "Excluded"}</td>
                  {row.arms.map((decision) => (
                    <td key={decision.arm}>{decision.scored ? formatScore(decision.probability) : decision.reason}</td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function trimPrompt(prompt: string): string {
  return prompt.length > 84 ? `${prompt.slice(0, 81)}...` : prompt;
}

function CalibrationChart({ bins }: { bins: CalibrationBin[] }) {
  const occupied = bins.filter((bin) => bin.count > 0 && bin.meanProbability != null && bin.frequency != null);
  if (occupied.length === 0) {
    return <p className="note">No scored forecasts for this arm, so there is no calibration curve.</p>;
  }
  const width = 320;
  const height = 320;
  const pad = 36;
  const plot = width - pad * 2;
  const xOf = (value: number) => pad + value * plot;
  const yOf = (value: number) => pad + (1 - value) * plot;
  const line = occupied.map((bin) => `${xOf(bin.meanProbability as number)},${yOf(bin.frequency as number)}`).join(" ");
  return (
    <svg className="chart" width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Calibration curve">
      <line x1={xOf(0)} y1={yOf(0)} x2={xOf(1)} y2={yOf(1)} stroke="#c9bfae" />
      <polyline fill="none" stroke="#1f4d3a" strokeWidth="2" points={line} />
      {occupied.map((bin) => (
        <circle
          key={bin.index}
          cx={xOf(bin.meanProbability as number)}
          cy={yOf(bin.frequency as number)}
          r={4 + Math.min(bin.count, 8)}
          fill="#8a4b08"
        >
          <title>
            {bin.count} forecast{bin.count === 1 ? "" : "s"}, mean {formatScore(bin.meanProbability)}, frequency{" "}
            {formatScore(bin.frequency)}
          </title>
        </circle>
      ))}
      <text x={pad} y={height - 8} fontSize="12">
        0
      </text>
      <text x={width - pad - 8} y={height - 8} fontSize="12">
        1
      </text>
      <text x={8} y={pad + 4} fontSize="12">
        1
      </text>
    </svg>
  );
}
