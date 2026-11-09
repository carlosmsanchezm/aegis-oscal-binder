"use client";
import { useState } from "react";
import { DATA_HANDLING, HONESTY, storageSentence } from "@/lib/account/copy";
import { initials, providerLabel, roleLabel } from "@/lib/account/text";
import type { Provider, Role } from "@/lib/account/types";
import "./account.css";

export function AccountMark() {
  return <div className="mark" aria-hidden="true"><span /></div>;
}

export function AccountFooter({ build, storage }: { build: string; storage: "blob" | "directory" | "unset" }) {
  const [open, setOpen] = useState(false);
  return <footer className="acct-foot">
    <b>OSCAL binder alpha</b>
    <span>version</span>
    <span>X · placeholder</span>
    <span className="acct-mono">build {build}</span>
    <span className="spacer" />
    <span>Not FedRAMP authorized · not an ATO</span>
    <button type="button" className="acct-linkish" aria-expanded={open} onClick={() => setOpen(!open)}>Alpha data handling</button>
    {open && <div className="acct-menu" role="dialog" aria-label="Alpha data handling" style={{ bottom: 36, top: "auto" }}>
      {DATA_HANDLING.map((line) => <p key={line} className="acct-copy">{line}</p>)}
      <p className="acct-copy">{storageSentence(storage)}</p>
      <p className="acct-copy">OSCAL binder is not FedRAMP authorized and is not an ATO.</p>
      <p className="acct-honesty">{HONESTY}</p>
    </div>}
  </footer>;
}

export function AccountMenu({ name, email, provider, role, org }: { name: string; email: string; provider: Provider; role: Role | null; org: string | null }) {
  const [open, setOpen] = useState(false);
  async function signOut() {
    await fetch("/api/auth/signout", { method: "POST" });
    window.location.assign("/sign-in");
  }
  return <div className="acct-user">
    <button type="button" aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen(!open)}>
      <span className="acct-avatar" aria-hidden="true">{initials(name, email)}</span>
      <span className="acct-quiet">▾</span>
    </button>
    {open && <div className="acct-menu" role="menu">
      <b>{name}</b>
      <span className="acct-quiet">{email}</span>
      {role && <span>Role {roleLabel(role)}</span>}
      {org && <span>Organization {org}</span>}
      <span>Signed in with {providerLabel(provider)} work account</span>
      <a href="/account/members">Organization and members</a>
      <a href="/account/settings">Workspace settings</a>
      <a href="/account/help">Help and feedback</a>
      <button type="button" onClick={() => void signOut()}>Sign out</button>
    </div>}
  </div>;
}
