import { DATA_HANDLING, HONESTY, NOT_BUILT, storageSentence } from "@/lib/account/copy";

export function SettingsPanel({
  orgName,
  workspaceName,
  pin,
  storage,
  adminName,
  canAdmin,
}: {
  orgName: string;
  workspaceName: string | null;
  pin: string | null;
  storage: "blob" | "directory" | "unset";
  adminName: string;
  canAdmin: boolean;
}) {
  return <section className="acct-panel" data-testid="settings-panel">
    <p className="acct-kicker">Workspace settings <span className="acct-pill warn">{NOT_BUILT}</span> rename and delete</p>
    <h1>Settings and data handling</h1>
    <p className="acct-copy">{orgName}{workspaceName ? ` · ${workspaceName}` : ""}</p>
    <p className="acct-honesty">{HONESTY}</p>
    <div className="acct-note">
      <b>Name</b>
      <p>{workspaceName ?? "No workspace yet"}</p>
      <button type="button" className="btn ghost" disabled>Rename <span className="acct-pill warn">{NOT_BUILT}</span></button>
    </div>
    <div className="acct-note">
      <b>Catalog pin</b>
      <p>{pin ?? "No package loaded"} {pin ? <span className="acct-quiet">read only</span> : null}</p>
    </div>
    <div className="acct-note">
      <b>Data handling</b>
      {DATA_HANDLING.map((line) => <p key={line}>{line}</p>)}
      <p>{storageSentence(storage)}</p>
      <p>OSCAL binder is not FedRAMP authorized and is not an ATO.</p>
    </div>
    <p><a className="btn ghost" href="/planning?view=export">Export everything</a></p>
    <p className="acct-quiet">Opens the planning export view for this browser&apos;s package.</p>
    <div className="acct-note">
      <b>Admin</b>
      <p>{adminName}</p>
      {!canAdmin && <p>Only an admin can rename or delete this workspace.</p>}
      <p>Rename, delete, and the typed confirmation are not built.</p>
      <button type="button" className="btn ghost" disabled>Delete workspace <span className="acct-pill warn">{NOT_BUILT}</span></button>
    </div>
    <p className="acct-honesty">{HONESTY}</p>
  </section>;
}

export function HelpPanel({ build }: { build: string }) {
  return <section className="acct-panel" data-testid="help-panel">
    <p className="acct-kicker">Help and feedback</p>
    <h1>Help</h1>
    <p className="acct-honesty">{HONESTY}</p>
    <div className="acct-note">
      <b>About</b>
      <p>Product OSCAL binder alpha</p>
      <p>Version X · placeholder</p>
      <p className="acct-mono">Build {build}</p>
      <p>Alpha agreement <span className="acct-pill warn">{NOT_BUILT}</span> No document yet.</p>
    </div>
    <form className="acct-field">
      <span>Send feedback</span>
      <textarea aria-label="Feedback" disabled rows={4} placeholder="What were you doing, and what did you expect?" />
      <button type="button" className="btn primary" disabled>Send feedback <span className="acct-pill warn">{NOT_BUILT}</span></button>
      <p className="acct-quiet">Mail is not configured, so this form does not send.</p>
    </form>
    <div className="acct-note">
      <b>Not built</b>
      <ul>
        <li>Invitation email. The invitation link works. Mail is not sent.</li>
        <li>Workspace rename</li>
        <li>Workspace delete</li>
        <li>Feedback mail</li>
        <li>Alpha agreement document</li>
      </ul>
    </div>
    <p className="acct-honesty">{HONESTY}</p>
  </section>;
}
