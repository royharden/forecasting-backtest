import { useState } from "react";
import { verifyBundle, type VerifyResult } from "../../supabase/functions/_shared/engine.ts";
import { messageOf } from "../lib/labels";
import { readFileText } from "../lib/session";

type BundlePanelProps = {
  canExport: boolean;
  onExport: () => void;
};

const BUNDLE_LIMIT = 16 * 1024 * 1024;

/** Required demo step: export the audit bundle, then import it here to recompute and compare. */
export function BundlePanel({ canExport, onExport }: BundlePanelProps) {
  const [result, setResult] = useState<VerifyResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <section className="panel" aria-labelledby="bundle-heading">
      <h2 id="bundle-heading">Export and Verify bundle</h2>
      <p className="note">
        The bundle holds the frozen dataset version, run manifest, every source decision, raw accepted and rejected attempts, selected attempts, metrics, bootstrap draw
        specification and the audit companion. It contains no credentials.
      </p>
      <div className="row">
        <button type="button" disabled={!canExport} onClick={onExport}>
          Download audit bundle
        </button>
        <label>
          Verify a bundle file
          <input
            type="file"
            accept="application/json,.json"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file == null) return;
              setError(null);
              setResult(null);
              void readFileText(file, BUNDLE_LIMIT)
                .then((text) => setResult(verifyBundle(JSON.parse(text))))
                .catch((cause: unknown) => setError(messageOf(cause)));
            }}
          />
        </label>
      </div>
      {error != null ? <p className="banner">{error}</p> : null}
      {result != null ? (
        <div>
          <p>
            <strong>{result.ok ? (result.reproducible ? "Verified: every check recomputes." : "Verified with redactions: not fully reproducible.") : "Mismatch found."}</strong>
          </p>
          <p className="note">{result.limitation}</p>
          <ul className="checks">
            {result.checks.map((check) => (
              <li key={check.name}>
                <span className={check.ok ? "badge ok" : "badge bad"}>{check.ok ? "ok" : "fail"}</span> {check.name}: <small>{check.detail}</small>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
