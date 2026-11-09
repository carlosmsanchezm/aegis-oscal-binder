"use client";
import { useState, type FormEvent } from "react";
import { HONESTY, roleLimit } from "@/lib/account/copy";
import { lastActiveLabel, providerLabel, roleLabel } from "@/lib/account/text";
import { ROLES, type Provider, type Role } from "@/lib/account/types";

type Member = { userId: string; name: string; email: string; provider: Provider | null; role: Role; lastActiveAt: string | null; you: boolean };
type Invitation = { id: string; email: string; role: Role; inviterName: string; createdAt: string; expiresAt: string };

export function MembersPanel({
  orgName,
  role,
  members,
  invitations,
}: {
  orgName: string;
  role: Role;
  members: Member[];
  invitations: Invitation[];
}) {
  const canManage = role === "admin";
  const [rows, setRows] = useState(members);
  const [pending, setPending] = useState(invitations);
  const [email, setEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<Role>("isso");
  const [link, setLink] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [removeId, setRemoveId] = useState<string | null>(null);
  const remove = rows.find((member) => member.userId === removeId);

  async function post(url: string, body: unknown, method = "POST") {
    const response = await fetch(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const payload = await response.json() as { ok?: boolean; error?: { message?: string }; members?: Member[]; invitations?: Invitation[]; link?: string };
    if (!response.ok || !payload.ok) throw new Error(payload.error?.message || "The request was refused.");
    return payload;
  }

  async function refresh() {
    const response = await fetch("/api/account/members");
    const payload = await response.json() as { ok?: boolean; members?: Member[]; invitations?: Invitation[] };
    if (payload.members) setRows(payload.members);
    if (payload.invitations) setPending(payload.invitations);
  }

  async function invite(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const payload = await post("/api/account/invitations", { email, role: inviteRole });
      setLink(payload.link ?? "");
      setEmail("");
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Invite not sent.");
    } finally {
      setBusy(false);
    }
  }

  async function change(userId: string, next: Role) {
    setError("");
    try {
      const payload = await post("/api/account/members", { userId, role: next }, "PATCH");
      if (payload.members) setRows(payload.members);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The role was not changed.");
    }
  }

  async function confirmRemove() {
    if (!remove) return;
    setBusy(true);
    setError("");
    try {
      const payload = await post("/api/account/members", { userId: remove.userId }, "DELETE");
      if (payload.members) setRows(payload.members);
      setRemoveId(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The member was not removed.");
    } finally {
      setBusy(false);
    }
  }

  return <div className="acct-split">
    <section className="acct-panel">
      <p className="acct-kicker">Members · {rows.length}</p>
      <h1>Organization and members</h1>
      <p className="acct-copy">{orgName} · only admins change roles. Role changes apply on the member&apos;s next request.</p>
      <p className="acct-note" data-testid="role-limit">{roleLimit(role)}</p>
      <table className="acct-table">
        <thead><tr><th>Member</th><th>Role</th><th>Signs in with</th><th>Last active</th><th></th></tr></thead>
        <tbody>
          {rows.map((member) => <tr key={member.userId}>
            <td><div className="acct-person"><span className="acct-avatar" aria-hidden="true">{member.name.slice(0, 1)}</span><span><b>{member.name}{member.you ? " (you)" : ""}</b><small>{member.email}</small></span></div></td>
            <td>{canManage && !member.you ? <select aria-label={`Role for ${member.name}`} value={member.role} onChange={(event) => void change(member.userId, event.target.value as Role)}>{ROLES.map((item) => <option key={item} value={item}>{roleLabel(item)}</option>)}</select> : <span className="acct-pill">{roleLabel(member.role)}</span>}</td>
            <td>{member.provider ? providerLabel(member.provider) : "—"}</td>
            <td>{lastActiveLabel(member.lastActiveAt)}</td>
            <td>{canManage && !member.you ? <button type="button" className="acct-linkish" onClick={() => setRemoveId(member.userId)}>Remove</button> : null}</td>
          </tr>)}
        </tbody>
      </table>
      {rows.length === 1 && <p className="acct-copy">You are the only member. Invite the people who work on this boundary.</p>}
      {error && <p className="acct-alert" role="alert">{error}</p>}
      {remove && <div className="acct-dialog" role="dialog" aria-label={`Remove ${remove.name}`}>
        <p>Remove {remove.name} from {orgName}? They lose access to this organization&apos;s workspaces on their next request.</p>
        <div className="acct-row">
          <button type="button" className="btn ghost" onClick={() => setRemoveId(null)}>Cancel</button>
          <button type="button" className="btn primary" disabled={busy} onClick={() => void confirmRemove()}>Remove member</button>
        </div>
      </div>}
      <p className="acct-honesty">{HONESTY}</p>
    </section>
    <aside className="acct-panel">
      <h2>Invite a member</h2>
      <form className="acct-field" onSubmit={invite}>
        <span>Work email</span>
        <input aria-label="Work email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} disabled={!canManage || busy} required={canManage} />
        <span>Role</span>
        <select aria-label="Invitation role" value={inviteRole} disabled={!canManage || busy} onChange={(event) => setInviteRole(event.target.value as Role)}>{ROLES.map((item) => <option key={item} value={item}>{roleLabel(item)}</option>)}</select>
        <p className="acct-quiet">They sign in with a Google or Microsoft work account at this address.</p>
        <button className="btn primary" type="submit" disabled={!canManage || busy} data-testid="send-invite">Send invite</button>
      </form>
      {!canManage && <p className="acct-note">Only an admin can invite members or change roles.</p>}
      {link && <div className="acct-note">
        <p><span className="acct-pill warn">Not built</span> Email is not sent. Copy this invitation link.</p>
        <input aria-label="Invitation link" data-testid="invite-link" readOnly value={link} />
      </div>}
      <h2>Pending invitations · {pending.length}</h2>
      {pending.map((invitation) => <div key={invitation.id} className="acct-note">
        <b>{invitation.email}</b> <span className="acct-pill">{roleLabel(invitation.role)}</span>
        <p className="acct-quiet">Sent by {invitation.inviterName} · not accepted yet</p>
        {canManage && <div className="acct-row">
          <button type="button" className="acct-linkish" onClick={() => void post("/api/account/invitations", { action: "resend", id: invitation.id }).then((payload) => { setLink(payload.link ?? ""); void refresh(); }).catch((cause) => setError(cause.message))}>Resend</button>
          <button type="button" className="acct-linkish" onClick={() => void post("/api/account/invitations", { action: "revoke", id: invitation.id }).then(() => refresh()).catch((cause) => setError(cause.message))}>Revoke</button>
        </div>}
      </div>)}
      <p className="acct-copy">Roles are enforced on the server. Every request checks the member&apos;s role for a claimed workspace boundary. Hiding a button on this page is not the control.</p>
      <p className="acct-honesty">{HONESTY}</p>
    </aside>
  </div>;
}
