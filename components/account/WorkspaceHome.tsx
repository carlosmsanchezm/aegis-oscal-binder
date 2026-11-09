"use client";
import { useState, type FormEvent } from "react";
import { HONESTY } from "@/lib/account/copy";
import { roleLabel } from "@/lib/account/text";
import type { Role } from "@/lib/account/types";

type Workspace = { id: string; name: string; createdAt: string };

export function WorkspaceHome({
  orgName,
  role,
  workspaces,
}: {
  orgName: string;
  role: Role;
  workspaces: Workspace[];
}) {
  const [name, setName] = useState("");
  const [claimBrowser, setClaimBrowser] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const canCreate = role === "admin" || role === "isso" || role === "system-owner";

  async function create(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const response = await fetch("/api/account", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "workspace", name, claimBrowser }),
    });
    const body = await response.json() as { ok?: boolean; error?: { message?: string }; workspace?: { id: string } };
    if (!response.ok || !body.ok || !body.workspace) {
      setBusy(false);
      setError(body.error?.message || "The workspace was not created.");
      return;
    }
    await open(body.workspace.id);
  }

  async function open(id: string) {
    setBusy(true);
    setError("");
    const response = await fetch(`/api/account/workspaces/${id}/open`, { method: "POST" });
    const body = await response.json() as { ok?: boolean; href?: string; error?: { message?: string } };
    if (!response.ok || !body.ok) {
      setBusy(false);
      setError(body.error?.message || "The workspace did not open.");
      return;
    }
    window.location.assign(body.href || "/planning");
  }

  return <div className="acct-split">
    <section className="acct-panel">
      <p className="acct-kicker">{orgName}</p>
      <h1>Workspaces</h1>
      <p className="acct-copy">A workspace owns the planning boundary and the system-connection owner for its members. {roleLabel(role)} is your role.</p>
      {workspaces.length === 0 && <p className="acct-note">No workspaces yet. Create one to claim this browser&apos;s session or start an empty boundary.</p>}
      <ul>
        {workspaces.map((workspace) => <li key={workspace.id} className="acct-note">
          <b>{workspace.name}</b>
          <div className="acct-row"><button type="button" className="btn primary" disabled={busy} onClick={() => void open(workspace.id)}>Open workspace</button></div>
        </li>)}
      </ul>
      <p className="acct-honesty">{HONESTY}</p>
    </section>
    <aside className="acct-panel">
      <h2>New workspace</h2>
      <form className="acct-field" onSubmit={create}>
        <span>Name</span>
        <input aria-label="Workspace name" value={name} onChange={(event) => setName(event.target.value)} disabled={!canCreate || busy} required={canCreate} maxLength={120} />
        <label className="acct-check"><input type="checkbox" checked={claimBrowser} disabled={!canCreate || busy} onChange={(event) => setClaimBrowser(event.target.checked)} /> Claim this browser&apos;s current session as the workspace boundary</label>
        <p className="acct-quiet">Leave this on to move the existing planning session and connection owner into the workspace. Turn it off to start an empty boundary. Opening a workspace points this browser at that boundary.</p>
        <button className="btn primary" type="submit" disabled={!canCreate || busy} data-testid="create-workspace">Create workspace</button>
      </form>
      {!canCreate && <p className="acct-note">This role cannot create a workspace.</p>}
      {error && <p className="acct-alert" role="alert">{error}</p>}
      <p className="acct-honesty">{HONESTY}</p>
    </aside>
  </div>;
}
