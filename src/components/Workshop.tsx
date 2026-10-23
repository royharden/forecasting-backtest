import { useEffect, useState } from "react";
import type { ArmDecision, ModelArm, QuestionRecord, QuestionReport, StudySet } from "../../supabase/functions/_shared/engine.ts";
import { RESOLUTION_PHRASE_MIN_LENGTH } from "../../supabase/functions/_shared/engine.ts";
import { ARM_LABEL, formatScore } from "../lib/labels";

type WorkshopProps = {
  study: StudySet;
  question: QuestionRecord;
  report: QuestionReport | undefined;
  account: boolean;
  busy: boolean;
  onPatch: (patch: Partial<QuestionRecord>) => void;
  onStoreQuestion: () => void;
  onAddSource: (input: { title: string; url: string; publishedAt: string; body: string }) => void;
  onDeleteSource: (sourceId: string) => void;
  onAddClaim: (text: string, sourceId: string | null) => void;
  onDeleteClaim: (claimId: string) => void;
  onStoreRecorded: (arm: ModelArm, probability: number, rationale: string) => void;
  onLive: (arm: ModelArm) => void;
};

export function Workshop({
  study,
  question,
  report,
  account,
  busy,
  onPatch,
  onStoreQuestion,
  onAddSource,
  onDeleteSource,
  onAddClaim,
  onDeleteClaim,
  onStoreRecorded,
  onLive,
}: WorkshopProps) {
  const sources = study.sources.filter((source) => source.questionId === question.id);
  const claims = study.claims.filter((claim) => claim.questionId === question.id);
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [publishedAt, setPublishedAt] = useState("");
  const [body, setBody] = useState("");
  const [claimText, setClaimText] = useState("");
  const [claimSource, setClaimSource] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  return (
    <section className="panel">
      <h2>Question</h2>
      {question.resolutionStatement.trim().length < RESOLUTION_PHRASE_MIN_LENGTH ? (
        <p className="note">The leak scan ignores a resolution sentence shorter than {RESOLUTION_PHRASE_MIN_LENGTH} characters.</p>
      ) : null}
      <div className="flags">
        {(report?.flags ?? [])
          .filter((flag) => flag.targetType === "question" || flag.targetId === question.id)
          .map((flag) => (
            <span key={`${flag.code}-${flag.targetId}`} className={flag.code === "model_memory_risk" ? "badge warn" : "badge bad"}>
              {flag.code}: {flag.detail}
            </span>
          ))}
        {report?.eligible === false ? <span className="badge bad">Excluded from scores</span> : null}
      </div>
      <label>
        Prompt
        <textarea value={question.prompt} onChange={(event) => onPatch({ prompt: event.target.value })} />
      </label>
      <div className="row">
        <label>
          Cutoff (UTC)
          <input value={question.cutoffAt} onChange={(event) => onPatch({ cutoffAt: event.target.value })} spellCheck={false} />
        </label>
        <label>
          Resolved (UTC)
          <input value={question.resolvedAt} onChange={(event) => onPatch({ resolvedAt: event.target.value })} spellCheck={false} />
        </label>
        <label>
          Outcome
          <select
            value={question.outcome ? "yes" : "no"}
            onChange={(event) => onPatch({ outcome: event.target.value === "yes" })}
          >
            <option value="yes">Yes</option>
            <option value="no">No</option>
          </select>
        </label>
        <label>
          YES price at cutoff
          <input
            type="number"
            min={0}
            max={1}
            step={0.01}
            value={question.marketPrice}
            onChange={(event) => onPatch({ marketPrice: Number(event.target.value) })}
          />
        </label>
      </div>
      <label>
        Resolution sentence (used only to detect leaks, never sent to the model)
        <textarea
          value={question.resolutionStatement}
          onChange={(event) => onPatch({ resolutionStatement: event.target.value })}
        />
      </label>
      <label>
        Declared model knowledge cutoff (optional, UTC)
        <input
          value={question.modelKnowledgeCutoff ?? ""}
          onChange={(event) => onPatch({ modelKnowledgeCutoff: event.target.value.trim() === "" ? null : event.target.value })}
          spellCheck={false}
        />
      </label>
      {account ? (
        <button type="button" disabled={busy} onClick={onStoreQuestion}>
          Store question
        </button>
      ) : (
        <p className="note">Edits stay in this browser until you store the set on an account.</p>
      )}

      <h3>Sources</h3>
      {sources.map((source) => {
        const admission = report?.sourceAdmissions.find((item) => item.sourceId === source.id);
        const flags = (report?.flags ?? []).filter((flag) => flag.targetId === source.id);
        return (
          <article key={source.id}>
            <strong>{source.title}</strong>{" "}
            <span className={admission?.admitted ? "badge ok" : "badge bad"}>
              {admission?.admitted ? "Admitted" : (admission?.reason ?? "Unchecked")}
            </span>
            <p className="note">
              {source.publishedAt ?? "Undated"} {source.url}
            </p>
            <p>{source.body}</p>
            <div className="flags">
              {flags.map((flag) => (
                <span key={flag.code} className="badge warn">
                  {flag.code}
                </span>
              ))}
            </div>
            <button type="button" className="quiet" disabled={busy} onClick={() => onDeleteSource(source.id)}>
              Remove source
            </button>
          </article>
        );
      })}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (title.trim() === "") {
            setFormError("A source needs a title.");
            return;
          }
          setFormError(null);
          onAddSource({ title: title.trim(), url: url.trim(), publishedAt: publishedAt.trim(), body: body.trim() });
          setTitle("");
          setUrl("");
          setPublishedAt("");
          setBody("");
        }}
      >
        <div className="row">
          <label>
            Title
            <input value={title} onChange={(event) => setTitle(event.target.value)} />
          </label>
          <label>
            URL
            <input value={url} onChange={(event) => setUrl(event.target.value)} spellCheck={false} />
          </label>
          <label>
            Published (UTC, blank if undated)
            <input value={publishedAt} onChange={(event) => setPublishedAt(event.target.value)} spellCheck={false} />
          </label>
        </div>
        <label>
          Body
          <textarea value={body} onChange={(event) => setBody(event.target.value)} />
        </label>
        <button type="submit" disabled={busy}>
          Add source
        </button>
      </form>

      <h3>Claims</h3>
      <p className="note">A research forecast is scored only when at least one attached claim cites an admitted source.</p>
      {claims.map((claim) => {
        const verdict = report?.critic.find((item) => item.claimId === claim.id);
        return (
          <article key={claim.id}>
            <p>{claim.text}</p>
            <span className={verdict?.admitted ? "badge ok" : "badge bad"}>{verdict?.reason ?? "Unchecked"}</span>
            <button type="button" className="quiet" disabled={busy} onClick={() => onDeleteClaim(claim.id)}>
              Remove claim
            </button>
          </article>
        );
      })}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (claimText.trim() === "") {
            setFormError("A claim needs text.");
            return;
          }
          setFormError(null);
          onAddClaim(claimText.trim(), claimSource === "" ? null : claimSource);
          setClaimText("");
        }}
      >
        <label>
          Claim
          <textarea value={claimText} onChange={(event) => setClaimText(event.target.value)} />
        </label>
        <label>
          Source
          <select value={claimSource} onChange={(event) => setClaimSource(event.target.value)}>
            <option value="">No source</option>
            {sources.map((source) => (
              <option key={source.id} value={source.id}>
                {source.title}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" disabled={busy}>
          Add claim
        </button>
      </form>

      <h3>Forecasts</h3>
      {(["no_research", "research"] as const).map((arm) => (
        <RecordedArm
          key={`${question.id}-${arm}`}
          arm={arm}
          question={question}
          study={study}
          decision={report?.arms.find((item) => item.arm === arm)}
          busy={busy}
          account={account}
          onStoreRecorded={onStoreRecorded}
          onLive={onLive}
          onError={setFormError}
        />
      ))}
      {formError != null ? <p className="note">{formError}</p> : null}
    </section>
  );
}

function RecordedArm({
  arm,
  question,
  study,
  decision,
  busy,
  account,
  onStoreRecorded,
  onLive,
  onError,
}: {
  arm: ModelArm;
  question: QuestionRecord;
  study: StudySet;
  decision: ArmDecision | undefined;
  busy: boolean;
  account: boolean;
  onStoreRecorded: (arm: ModelArm, probability: number, rationale: string) => void;
  onLive: (arm: ModelArm) => void;
  onError: (message: string | null) => void;
}) {
  const latest = [...study.forecasts].reverse().find((forecast) => forecast.questionId === question.id && forecast.arm === arm);
  const [probability, setProbability] = useState(latest == null ? "" : String(latest.probability));
  const [rationale, setRationale] = useState(latest?.rationale ?? "");

  useEffect(() => {
    setProbability(latest == null ? "" : String(latest.probability));
    setRationale(latest?.rationale ?? "");
  }, [latest?.id, latest?.probability, latest?.rationale]);

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const value = Number(probability);
        if (!Number.isFinite(value) || value < 0 || value > 1) {
          onError("A recorded probability must be a number from 0 to 1.");
          return;
        }
        onError(null);
        onStoreRecorded(arm, value, rationale);
      }}
    >
      <h3>{ARM_LABEL[arm]}</h3>
      <p className="note">
        {decision == null
          ? "This question is not in the current scoreboard."
          : decision.scored
            ? `Scored at ${formatScore(decision.probability)}. ${decision.reason}`
            : `Not scored. ${decision.reason}`}
      </p>
      <div className="row">
        <label>
          Recorded probability
          <input
            type="number"
            min={0}
            max={1}
            step={0.01}
            value={probability}
            onChange={(event) => setProbability(event.target.value)}
          />
        </label>
      </div>
      <label>
        Rationale
        <textarea value={rationale} onChange={(event) => setRationale(event.target.value)} />
      </label>
      <div className="row">
        <button type="submit" disabled={busy}>
          Store recorded forecast
        </button>
        <button
          type="button"
          className="quiet"
          disabled={busy || !account}
          onClick={() => onLive(arm)}
        >
          Generate live forecast
        </button>
      </div>
      {account ? null : (
        <p className="note">Live forecasts run only for a question stored on your account. This button does not invent a probability.</p>
      )}
    </form>
  );
}
