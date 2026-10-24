import type { AttemptRecord, ClaimDecision, PromptEvidence, QuestionExecution, RunManifest } from "../../supabase/functions/_shared/engine.ts";
import { parseUtc } from "../../supabase/functions/_shared/engine.ts";
import { formatScore, reasonLabel, shortHash } from "../lib/labels";

type AttemptInspectorProps = {
  manifest: RunManifest;
  execution: QuestionExecution;
  questionOpensAt: string;
};

export function AttemptInspector({ manifest, execution, questionOpensAt }: AttemptInspectorProps) {
  return (
    <section className="panel" aria-labelledby="attempts-heading">
      <h2 id="attempts-heading">Model arms for {execution.questionId}</h2>
      <p className="note">
        Memory check: <MemoryStatus manifest={manifest} opensAt={questionOpensAt} /> Prompt evidence hash {shortHash(execution.gate.promptEvidenceHash)} ({execution.gate.promptEvidence.length}{" "}
        excerpt(s)).
      </p>
      {(["no_research", "research"] as const).map((arm) => {
        const result = execution.arms[arm];
        return (
          <div key={arm} className="arm">
            <h3>
              {arm === "no_research" ? "No research (frozen first, no evidence)" : "Research (strict, supported spans only)"}
            </h3>
            <p>
              <span className={result.state === "done" ? "badge ok" : result.state === "pending" ? "badge" : "badge bad"}>{reasonLabel(result.reasonCode)}</span>{" "}
              {result.probability != null ? `Scored p = ${formatScore(result.probability, 2)}` : "Not scored"}
              {result.withheldProbability != null ? ` · unscored audit p = ${formatScore(result.withheldProbability, 2)}` : ""} · {result.chargedCalls} of 2 {manifest.mode === "live" ? "charged calls" : "attempt slots (no charge in replay)"} used.
            </p>
            <p className="note">{result.reason}</p>
            {result.attempts.map((attempt) => (
              <AttemptView key={attempt.attemptId} attempt={attempt} evidence={execution.gate.promptEvidence} selected={attempt.attemptId === result.selectedAttemptId} />
            ))}
          </div>
        );
      })}
    </section>
  );
}

function MemoryStatus({ manifest, opensAt }: { manifest: RunManifest; opensAt: string }) {
  if (manifest.datasetKind === "synthetic") return <span>N/A for synthetic data.</span>;
  const profile = manifest.modelProfile;
  if (profile == null) return <span>Recorded outputs: model training cutoff unknown, temporal risk unknown.</span>;
  const cutoff = parseUtc(profile.declaredTrainingCutoff);
  const opens = parseUtc(opensAt);
  if (cutoff == null || opens == null) return <span>Declared training cutoff unknown.</span>;
  return (
    <span>
      Declared training cutoff {profile.declaredTrainingCutoff} is {cutoff < opens ? "before" : "not before"} this question opened. A declared cutoff does not prove training
      composition.
    </span>
  );
}

function AttemptView({ attempt, evidence, selected }: { attempt: AttemptRecord; evidence: PromptEvidence[]; selected: boolean }) {
  const e = attempt.evaluation;
  return (
    <div className={selected ? "attempt selected" : "attempt"}>
      <p>
        <strong>
          Attempt {attempt.sequence} ({attempt.kind})
        </strong>{" "}
        · origin {attempt.origin} · request {shortHash(attempt.requestHash)} · {e.status}
        {selected ? " · selected" : ""}
        {attempt.auditFlags.map((flag) => (
          <span key={flag} className="badge warn">
            {flag}
          </span>
        ))}
      </p>
      {e.status === "failed" ? (
        <p className="note">
          {e.code}: {e.detail}
        </p>
      ) : (
        <>
          <p>
            p = {formatScore(e.probability, 2)} — {e.rationale}
          </p>
          {e.status === "withheld" ? (
            <p className="note">
              {e.reason}
              {e.feedback.length > 0 ? ` Correction feedback sent: ${e.feedback.map((f) => `#${f.claimIndex} ${f.code}`).join(", ")} (codes only).` : " No correction follows."}
            </p>
          ) : null}
          {e.claims.length > 0 ? (
            <ol className="claims">
              {e.claims.map((claim) => (
                <ClaimView key={claim.claimIndex} claim={claim} evidence={evidence} />
              ))}
            </ol>
          ) : null}
        </>
      )}
    </div>
  );
}

function ClaimView({ claim, evidence }: { claim: ClaimDecision; evidence: PromptEvidence[] }) {
  const source = evidence.find((item) => item.evidenceId === claim.evidenceId);
  const supported = claim.verdict === "supported";
  return (
    <li>
      <span className={supported ? "badge ok" : "badge bad"}>{claim.verdict}</span> “{claim.text || "(empty)"}” → {claim.evidenceId} [{claim.start}, {claim.end})
      {supported && source != null ? (
        <blockquote>
          {source.excerpt.slice(0, claim.start)}
          <mark>{source.excerpt.slice(claim.start, claim.end)}</mark>
          {source.excerpt.slice(claim.end)}
        </blockquote>
      ) : null}
    </li>
  );
}
