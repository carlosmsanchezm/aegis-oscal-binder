"use client";
import { useState, type FormEvent } from "react";
import { HONESTY, SIGN_IN } from "@/lib/account/copy";
import { providerLabel } from "@/lib/account/text";
import type { Provider, Role } from "@/lib/account/types";
import { roleLabel } from "@/lib/account/text";

export function SignInCard({
  mode,
  returnTo,
  returnLabel,
  providers,
  user,
}: {
  mode: "buttons" | "signed-in" | "no-org" | "expired" | "failed" | "personal" | "unverified" | "configuration";
  returnTo: string;
  returnLabel: string;
  providers: { google: boolean; microsoft: boolean; secret: boolean };
  user?: { name: string; email: string; provider: Provider; initials: string; orgName?: string | null; role?: Role | null } | null;
}) {
  const [waiting, setWaiting] = useState<Provider | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const ready = providers.secret;
  function start(provider: Provider) {
    if (!ready || !providers[provider]) {
      window.location.assign(`/sign-in?error=configuration&return=${encodeURIComponent(returnTo)}`);
      return;
    }
    setWaiting(provider);
    window.location.assign(`/api/auth/signin/${provider}?return=${encodeURIComponent(returnTo)}`);
  }
  async function createOrg(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const response = await fetch("/api/account", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) });
    const body = await response.json() as { ok?: boolean; error?: { message?: string } };
    if (!response.ok || !body.ok) {
      setBusy(false);
      setError(body.error?.message || "The organization was not created.");
      return;
    }
    window.location.assign("/account");
  }
  async function signOut() {
    await fetch("/api/auth/signout", { method: "POST" });
    window.location.assign(`/sign-in?return=${encodeURIComponent(returnTo)}`);
  }
  const showButtons = mode !== "signed-in";
  return <section className="acct-card" data-testid="sign-in-card">
    {mode === "signed-in" && user ? <>
      <p className="acct-kicker">Signed in</p>
      <h1>{SIGN_IN.welcome}</h1>
      <p>{SIGN_IN.welcomeBody}</p>
      <div className="acct-identity">
        <span className="acct-avatar" aria-hidden="true">{user.initials}</span>
        <div><b>{user.name}</b><span>{user.email}</span><span>{providerLabel(user.provider)} work account{user.orgName ? ` · ${user.orgName}` : ""}{user.role ? ` · ${roleLabel(user.role)}` : ""}</span></div>
      </div>
      <p>Taking you to {returnLabel}</p>
      <div className="acct-row">
        <a className="btn primary" href={returnTo}>Go now</a>
        <button type="button" className="btn ghost" onClick={() => void signOut()}>Not you? Sign out</button>
      </div>
    </> : <>
      <p className="acct-kicker">{mode === "expired" ? SIGN_IN.expiredTitle : "Sign in"}</p>
      <h1>{mode === "no-org" ? "This account is not in an organization" : mode === "expired" ? "Sign in again to continue" : SIGN_IN.title}</h1>
      <p>{mode === "expired" ? SIGN_IN.expired : mode === "no-org" && user ? `Signed in with ${providerLabel(user.provider)} as ${user.email}, but this address is not a member of any organization. ${SIGN_IN.noOrg}` : SIGN_IN.body}</p>
      {mode === "failed" && <p className="acct-alert" role="alert">{SIGN_IN.failed}</p>}
      {mode === "personal" && <p className="acct-alert" role="alert">{SIGN_IN.personal}</p>}
      {mode === "unverified" && <p className="acct-alert" role="alert">{SIGN_IN.unverified}</p>}
      {(mode === "configuration" || !ready || (!providers.google && !providers.microsoft)) && <p className="acct-alert" role="status">{ready ? SIGN_IN.configurationProviders : SIGN_IN.configuration}</p>}
      {mode === "expired" && <p className="acct-note">After sign in {returnLabel}</p>}
    </>}
    {showButtons && <div className="acct-actions">
      <button type="button" className="acct-provider" data-testid="sign-in-google" disabled={waiting !== null} onClick={() => start("google")}>
        <span className="acct-letter g" aria-hidden="true">G</span>
        {waiting === "google" ? SIGN_IN.waiting("Google") : SIGN_IN.google}
      </button>
      <button type="button" className="acct-provider" data-testid="sign-in-microsoft" disabled={waiting !== null} onClick={() => start("microsoft")}>
        <span className="acct-letter m" aria-hidden="true">M</span>
        {waiting === "microsoft" ? SIGN_IN.waiting("Microsoft") : SIGN_IN.microsoft}
      </button>
      {waiting && <button type="button" className="acct-linkish" onClick={() => setWaiting(null)}>Cancel</button>}
      {waiting && <p className="acct-quiet">Finish signing in in the {waiting === "google" ? "Google" : "Microsoft"} window.</p>}
      {mode !== "no-org" && <p className="acct-quiet">{SIGN_IN.hosted}</p>}
    </div>}
    {mode === "no-org" && user && <form className="acct-field" onSubmit={createOrg}>
      <span>{SIGN_IN.createOrg}</span>
      <span className="acct-quiet">{SIGN_IN.createOrgNote}</span>
      <input aria-label="Organization name" value={name} onChange={(event) => setName(event.target.value)} required maxLength={80} />
      <button className="btn primary" type="submit" disabled={busy} data-testid="create-org">Create organization</button>
      {error && <p className="acct-alert" role="alert">{error}</p>}
      <button type="button" className="btn ghost" onClick={() => void signOut()}>Use a different account</button>
    </form>}
    <p className="acct-honesty">{SIGN_IN.alpha}</p>
    <p className="acct-honesty" data-testid="account-honesty">{HONESTY}</p>
  </section>;
}
