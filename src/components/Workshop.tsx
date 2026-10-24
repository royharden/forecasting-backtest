import { useState } from "react";
import { LIMITS, type ImportIssue } from "../../supabase/functions/_shared/engine.ts";
import { harborManifestJson } from "../lib/demoPack";
import { blankRealDraft } from "../lib/studyEdit";

type WorkshopProps = {
  busy: boolean;
  /** Freeze the draft as a new version. Returns structural errors, or null on success. */
  onFreeze: (text: string) => ImportIssue[] | null;
};

/**
 * Draft workshop: edit manifest v1 JSON, then freeze it as a new immutable version. Structural
 * problems fail the whole draft; temporal/wording/outcome problems become visible quarantine rows.
 */
export function Workshop({ busy, onFreeze }: WorkshopProps) {
  const [text, setText] = useState("");
  const [errors, setErrors] = useState<ImportIssue[] | null>(null);
  const bytes = new TextEncoder().encode(text).length;
  return (
    <section className="panel" aria-labelledby="workshop-heading">
      <h2 id="workshop-heading">Draft workshop</h2>
      <p className="note">
        Edit a manifest v1 draft. Freezing validates it and creates a new version; past versions and runs never change. For real data, prepare files offline with{" "}
        <code>scripts/prepare-manifest.ts</code> (see README). URLs are inert and never fetched.
      </p>
      <div className="row">
        <button type="button" className="quiet" onClick={() => setText(harborManifestJson())}>
          Start from Harbor (synthetic)
        </button>
        <button type="button" className="quiet" onClick={() => setText(blankRealDraft())}>
          Start from real-data template
        </button>
      </div>
      <label>
        Manifest JSON ({bytes.toLocaleString()} of {LIMITS.importBytes.toLocaleString()} bytes)
        <textarea className="code" value={text} onChange={(event) => setText(event.target.value)} spellCheck={false} rows={16} />
      </label>
      <button
        type="button"
        disabled={busy || text.trim() === ""}
        onClick={() => {
          setErrors(onFreeze(text));
        }}
      >
        Validate and freeze as new version
      </button>
      {errors != null && errors.length > 0 ? (
        <div className="banner" role="alert">
          <p>The draft was not frozen. Nothing was committed.</p>
          <ul>
            {errors.slice(0, 50).map((issue) => (
              <li key={`${issue.path}-${issue.code}-${issue.message}`}>
                <code>{issue.path}</code> {issue.code}: {issue.message}
              </li>
            ))}
          </ul>
          {errors.length > 50 ? <p>{errors.length - 50} more…</p> : null}
        </div>
      ) : null}
    </section>
  );
}
