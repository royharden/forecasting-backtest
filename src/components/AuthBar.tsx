import { useEffect, useState } from "react";
import { getSupabase } from "../lib/supabaseClient";

type AuthBarProps = {
  configured: boolean;
  email: string | null;
};

export function AuthBar({ configured, email }: AuthBarProps) {
  const [address, setAddress] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [recovering, setRecovering] = useState(false);

  useEffect(() => {
    const supabase = getSupabase();
    if (supabase == null) return;
    const { data } = supabase.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY") setRecovering(true);
    });
    return () => data.subscription.unsubscribe();
  }, []);

  async function sendReset() {
    const supabase = getSupabase();
    if (supabase == null || address.trim() === "") {
      setMessage("Enter the account email first.");
      return;
    }
    setBusy(true);
    // The owner must allow this origin in Auth redirect URLs (see BOLT-HANDOFF.md).
    const { error } = await supabase.auth.resetPasswordForEmail(address.trim(), { redirectTo: window.location.origin });
    setBusy(false);
    setMessage(error != null ? error.message : "If that account exists, a recovery email is on its way.");
  }

  async function setNewPassword() {
    const supabase = getSupabase();
    if (supabase == null) return;
    setBusy(true);
    const { error } = await supabase.auth.updateUser({ password });
    setBusy(false);
    if (error != null) {
      setMessage(error.message);
      return;
    }
    setPassword("");
    setRecovering(false);
    setMessage("Password updated.");
  }

  async function submit(kind: "sign-in" | "sign-up") {
    const supabase = getSupabase();
    if (supabase == null) return;
    setBusy(true);
    setMessage(null);
    const credentials = { email: address.trim(), password };
    const result =
      kind === "sign-in"
        ? await supabase.auth.signInWithPassword(credentials)
        : await supabase.auth.signUp(credentials);
    setBusy(false);
    if (result.error != null) {
      setMessage(result.error.message);
      return;
    }
    setPassword("");
    if (kind === "sign-up" && result.data.session == null) {
      setMessage("Account created. If email confirmation is on, confirm the message, then sign in.");
    }
  }

  async function signOut() {
    const supabase = getSupabase();
    if (supabase == null) return;
    const { error } = await supabase.auth.signOut();
    if (error != null) setMessage(error.message);
  }

  if (!configured) {
    return (
      <p className="note">
        No Bolt Database URL or anon key is set. This is a browser-only session: nothing is stored and no model is called.
      </p>
    );
  }

  if (recovering) {
    return (
      <form
        className="auth"
        onSubmit={(event) => {
          event.preventDefault();
          void setNewPassword();
        }}
      >
        <label>
          New password
          <input type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} required minLength={6} />
        </label>
        <button type="submit" disabled={busy}>
          Set new password
        </button>
        {message != null ? <p className="note">{message}</p> : null}
      </form>
    );
  }

  if (email != null) {
    return (
      <div className="auth">
        <p>Signed in as {email}.</p>
        <button type="button" className="quiet" onClick={() => void signOut()}>
          Sign out
        </button>
        {message != null ? <p className="note">{message}</p> : null}
      </div>
    );
  }

  return (
    <form
      className="auth"
      onSubmit={(event) => {
        event.preventDefault();
        void submit("sign-in");
      }}
    >
      <label>
        Email
        <input type="email" autoComplete="username" value={address} onChange={(event) => setAddress(event.target.value)} required />
      </label>
      <label>
        Password
        <input
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          required
          minLength={6}
        />
      </label>
      <button type="submit" disabled={busy}>
        Sign in
      </button>
      <button type="button" className="quiet" disabled={busy} onClick={() => void submit("sign-up")}>
        Create account
      </button>
      <button type="button" className="quiet" disabled={busy} onClick={() => void sendReset()}>
        Forgot password
      </button>
      {message != null ? <p className="note">{message}</p> : null}
    </form>
  );
}
