"use client";
import { useState } from "react";
import { HONESTY, SIGN_IN } from "@/lib/account/copy";
import { providerLabel, roleLabel } from "@/lib/account/text";
import type { Provider, Role } from "@/lib/account/types";

export function InviteCard({
  token,
  state,
  orgName,
  role,
  inviterName,
  invitedEmail,
  user,
  alreadyMember,
}: {
  token: string;
  state: "valid" | "expired" | "revoked" | "accepted" | "missing";
  orgName?: string;
  role?: Role;
  inviterName?: string;
  invitedEmail?: string;
  user: { email: string; provider: Provider } | null;
  alreadyMember: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const mismatch = !!user && !!invitedEmail && user.email !== invitedEmail;
  const usable = state === "valid" && !mismatch && !alreadyMember;
  async function join() {
    setBusy(true);
    setError("");
    const response = await fetch("/api/account/invitations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "accept", token }),
    });
    const body = await response.json() as { ok?: boolean; error?: { message?: string } };
    if (!response.ok || !body.ok) {
      setBusy(false);
      setError(body.error?.message || "Join failed. The membership store did not answer, so you were not added.");
      return;
    }
    window.location.assign("/account");
  }
  async function switchAccount() {
    await fetch("/api/auth/signout", { method: "POST" });
    window.location.assign(`/sign-in?return=${encodeURIComponent(`/invite/${token}`)}`);
  }
  return <section className="acct-card" data-testid="invite-card">
    <p className="acct-kicker">Invitation</p>
    {state === "missing" || state === "expired" || state === "revoked" ? <>
      <h1>This invitation is no longer valid</h1>
      <p>It expired or was revoked. Ask the admin{orgName ? ` of ${orgName}` : ""} to send a new one.</p>
      <button type="button" className="btn primary" disabled>Join {orgName ?? "organization"}</button>
      <p className="acct-quiet">Join is off because the invitation cannot be used.</p>
    </> : alreadyMember ? <>
      <h1>You are already a member of {orgName}</h1>
      {role && <p>Your role {roleLabel(role)}</p>}
      <a className="btn primary" href="/account">Open workspace</a>
    </> : <>
      <h1>You are invited to {orgName} as {role ? roleLabel(role) : "a member"}</h1>
      <p>Invited by {inviterName ?? "an admin"}.</p>
      {mismatch ? <div className="acct-alert" role="alert">
        <p>This invitation is for a different account.</p>
        <p>You are signed in as {user?.email}. The invitation was sent to {invitedEmail}.</p>
      </div> : <p>Sign in with the work account this invitation was sent to. Google or Microsoft work accounts only.</p>}
      {!user && <div className="acct-actions">
        <a className="acct-provider" href={`/api/auth/signin/google?return=${encodeURIComponent(`/invite/${token}`)}`}><span className="acct-letter g" aria-hidden="true">G</span>{SIGN_IN.google}</a>
        <a className="acct-provider" href={`/api/auth/signin/microsoft?return=${encodeURIComponent(`/invite/${token}`)}`}><span className="acct-letter m" aria-hidden="true">M</span>{SIGN_IN.microsoft}</a>
      </div>}
      {user && !mismatch && <p className="acct-note">Signed in with {providerLabel(user.provider)} as {user.email}.</p>}
      <button type="button" className="btn primary" data-testid="join-workspace" disabled={!usable || busy} onClick={() => void join()}>Join {orgName}</button>
      {mismatch && <button type="button" className="btn ghost" onClick={() => void switchAccount()}>Switch account</button>}
      {!user && <p className="acct-quiet">Join turns on after you sign in with the invited account.</p>}
      {mismatch && <p className="acct-quiet">Join is off because the signed in account does not match the invitation.</p>}
      {busy && <p role="status">Joining…</p>}
      {error && <p className="acct-alert" role="alert">{error} <button type="button" className="acct-linkish" onClick={() => void join()}>Retry</button></p>}
    </>}
    <p className="acct-honesty" data-testid="account-honesty">{HONESTY}</p>
  </section>;
}
