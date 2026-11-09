"use client";
import {importEvidenceEvents} from "@/lib/client/import-evidence-events";
import { useEffect, useRef, useState } from "react";
import { useConnectedEvidence } from "../binder/useConnectedEvidence";
import { checkState, freshnessLabel } from "@/lib/builder/evidence";
import { observationControl } from "@/lib/aegis/connected-evidence";
import { requestMessage, utcTime, receiptLabel } from "@/lib/builder/presentation";
import { evidenceViewerHref } from "@/lib/builder/evidence-links";
import { CONNECTIONS } from "@/lib/aegis/ui-copy";
import styles from "./BuilderWorkspace.module.css";

function download(name: string, value: string) {
  const url = URL.createObjectURL(new Blob([value], { type: "application/json" })), a = document.createElement("a");
  a.href = url; a.download = name; a.click(); URL.revokeObjectURL(url);
}
export function SystemConnections({ store, onMap, onEvidence, onArtifactLoad, onRecordedEvidence }: { store: ReturnType<typeof useConnectedEvidence>; onMap: () => void; onEvidence: (receiptIds?: string[]) => void; onArtifactLoad?: (receiptIds: string[]) => void; onRecordedEvidence?: () => void }) {
  const mounted = useRef(true);
  useEffect(()=>{mounted.current=true;return ()=>{mounted.current=false;};},[]);
  const { connections, selectedId: selected, select: setSelected, loading, error: readError, refresh, connection: activeConnection } = store;
  const [setupId,setSetupId]=useState<string|null>(null);
  const connection=connections.find(c=>c.id === setupId) ?? activeConnection;
  useEffect(()=>{setSetupId(null);},[selected]);
  const [arrived, setArrived] = useState(0);
  const [referenceLoading, setReferenceLoading] = useState(false), [referenceLoaded, setReferenceLoaded] = useState(false), [reveal, setReveal] = useState(false), [copied, setCopied] = useState<string | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const [name, setName] = useState(""), [credential, setCredential] = useState<{ id: string; token: string } | null>(null);
  const [origin, setOrigin] = useState(""), [allowed, setAllowed] = useState(""), [denied, setDenied] = useState("");
  const [framework, setFramework] = useState("NIST SP 800-53 Rev 5"), [reference, setReference] = useState("AC-6");
  const [job,setJob]=useState<"gitlab"|"github">("gitlab"),[fullJob,setFullJob]=useState(false),[editSetup,setEditSetup]=useState(true),[setupOpen,setSetupOpen]=useState(false);
  const [selectedEvent, setSelectedEvent] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  // Explanations stay one click away so each card shows name, source, count and its main action.
  const infoButton = (id: string, label: string) => <button type="button" className={styles.infoToggle} aria-label={CONNECTIONS.info(label)} aria-expanded={info === id} aria-controls={`connection-info-${id}`} onClick={() => setInfo(info === id ? null : id)}>i</button>;
  const infoPanel = (id: string, children: React.ReactNode) => info === id ? <div id={`connection-info-${id}`} className={styles.info}>{children}</div> : null;
  const [objective, setObjective] = useState("The specified caller can reach the required endpoint and is rejected by the prohibited endpoint.");
  useEffect(() => { setOrigin(window.location.origin); }, []);
  useEffect(()=>{setFullJob(false);setEditSetup(true);setCopied(null);setSetupOpen(credential?.id === connection?.id);},[connection?.id]);
  async function connect(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError(null);
    try {
      const response = await fetch("/api/builder", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) });
      const body = await response.json();
      if (!response.ok || !body.ok) throw new Error(body.error || "Could not create connection.");
      setReferenceLoaded(false); setReveal(false); setCredential({ id: body.connection.id, token: body.token }); setSetupId(body.connection.id); setName("");
      await refresh();
    } catch (e) { setError(requestMessage(e,"Connection unavailable.")); }
    finally { setBusy(false); }
  }
  const endpoint = connection ? `${origin}/api/builder/connections/${connection.id}/events` : "";
  async function revoke() {
    if (!connection) return;
    setBusy(true); setError(null);
    try {
      const response = await fetch(`/api/builder/connections/${connection.id}`, { method: "DELETE" });
      if (!response.ok) throw new Error("Could not revoke the upload credential.");
      setCredential(null); await refresh();
    } catch (e) { setError(requestMessage(e,"Revocation unavailable.")); }
    finally { setBusy(false); }
  }
  async function importEvent(file: File | undefined) {
    if (!file || !connection) return;
    setBusy(true); setError(null);
    try {
      if (file.size > 512_000) throw new Error("Use a collector event smaller than 500 KB.");
      const response = await fetch(`/api/builder/connections/${connection.id}/imports`, { method: "POST", headers: { "content-type": "application/json" }, body: await file.text() });
      const body = await response.json();
      if (!response.ok || !body.ok) throw new Error(body.error || "Observation rejected.");
      await refresh();
      onArtifactLoad?.([...connection.history.map(item => item.id), body.evidenceId]);
    } catch (e) { setError(requestMessage(e,"Observation import failed.")); }
    finally { setBusy(false); }
  }
  async function loadReference() {
    setReferenceLoading(true); setReferenceLoaded(false); setArrived(0); setBusy(true); setError(null);
    try {
      const response = await fetch("/api/builder/reference", { cache: "no-store" });
      const capture = await response.json();
      if (!response.ok || !capture.ok) throw new Error(capture.error || "Reference capture unavailable.");
      let id = connections.find(c => c.name === capture.name && !c.revokedAt)?.id;
      if (!id) {
        const created = await fetch("/api/builder", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: capture.name }) });
        const body = await created.json();
        if (!created.ok || !body.ok) throw new Error(body.error || "Could not create reference connection.");
        id = body.connection.id;
      }
      setSetupId(null);setSelected(id!); setCredential(null);
      const receivedArtifacts = new Set<string>();
      // Bounded parallel imports retain each original receipt and digest. Refresh
      // once after all writes, instead of rereading the growing history per batch.
      const events = capture.events as {id:string;rawEvent:string}[];
      await importEvidenceEvents(events,async event=>{
       const published=await fetch(`/api/builder/connections/${id}/imports`,{method:"POST",headers:{"content-type":"application/json"},body:event.rawEvent});
       const receipt=await published.json();
       if(!published.ok || !receipt.ok || receipt.evidenceId!==event.id)throw new Error(receipt.error || "Reference receipt mismatch.");
      },event=>{
       for(const artifact of JSON.parse(event.rawEvent).artifacts ?? [])receivedArtifacts.add(`${event.id}:${artifact.name}`);
       if(mounted.current)setArrived(receivedArtifacts.size);
      });
      await refresh(); setReferenceLoaded(true); if(mounted.current)onEvidence(capture.events.map((event: {id: string}) => event.id));
    } catch (e) { setError(requestMessage(e,"Reference import failed.")); await refresh(); }
    finally { setBusy(false); setReferenceLoading(false); }
  }
  async function copy(value: string, label: string) {
    try { await navigator.clipboard.writeText(value); setCopied(label); } catch { setError("Clipboard unavailable. Select and copy the text."); }
  }
  function config() {
    if (!connection) return;
    try {
      for (const raw of [allowed, denied]) {
        const u = new URL(raw);
        if (!["http:", "https:"].includes(u.protocol) || u.username || u.password || u.search || u.hash) throw new Error("Use HTTP(S) probe URLs without credentials, query strings or fragments.");
      }
      if (!framework.trim() || !reference.trim() || !objective.trim()) throw new Error("Complete the requirement and objective.");
      download("access-check.json", JSON.stringify({ subject: { id: connection.name }, requirement: { framework, reference, objective }, probes: { allowed: { url: allowed, expectedStatus: 200 }, denied: { url: denied, expectedStatus: 403 } }, freshnessSeconds: 3600 }, null, 2));
    } catch (e) { setError(requestMessage(e,"Invalid check configuration.")); }
  }
  const gitlab = `binder-evidence:
  image: node:20
  script:
    - result=0
    - node .aegis/builder-evidence.mjs check-access --config .aegis/access-check.json --revision "$AEGIS_SUBJECT_REVISION" --run-id "$CI_PIPELINE_ID" --run-url "$CI_PIPELINE_URL" --out evidence-event.json || result=$?
    - node .aegis/builder-evidence.mjs publish --file evidence-event.json --endpoint "$AEGIS_BUILDER_ENDPOINT"
    - exit "\${result:-0}"
  artifacts:
    when: always
    paths: [evidence-event.json]`;
  const github = `name: Binder evidence
on: [workflow_dispatch]
jobs:
  evidence:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2
      - name: Observe and publish
        env:
          AEGIS_BUILDER_TOKEN: \${{ secrets.AEGIS_BUILDER_TOKEN }}
          AEGIS_BUILDER_ENDPOINT: \${{ vars.AEGIS_BUILDER_ENDPOINT }}
          AEGIS_SUBJECT_REVISION: \${{ vars.AEGIS_SUBJECT_REVISION }}
          RUN_URL: \${{ github.server_url }}/\${{ github.repository }}/actions/runs/\${{ github.run_id }}
        run: |
          result=0
          node .aegis/builder-evidence.mjs check-access --config .aegis/access-check.json --revision "$AEGIS_SUBJECT_REVISION" --run-id "$GITHUB_RUN_ID" --run-url "$RUN_URL" --out evidence-event.json || result=$?
          node .aegis/builder-evidence.mjs publish --file evidence-event.json --endpoint "$AEGIS_BUILDER_ENDPOINT"
          exit "$result"`;
  const history = connection?.history ?? [];
  const linkedControls = new Set(history.flatMap(h => h.checks.map(observationControl).filter(Boolean)));
  const artifactCount = history.reduce((total, h) => total + h.artifacts.length, 0);
  return <section className={styles.workspace} aria-label="System connections">
    <div className={styles.layout}><div className={`${styles.content}${fullJob ? ` ${styles.ciFocused}` : ""}`}>
    <div className={styles.heading}><h1>System connections</h1>{infoButton("workspace", "System connections")}</div>
    {infoPanel("workspace", <p>Collect observations for the package map, control evidence and remediation review.</p>)}
    <p className={styles.notice}><strong>Pilot</strong> Workspace belongs to this browser session. No accounts, team roles or recovery yet. Use approved test data.</p>
    {readError && <p role="status" className={styles.notice}>{readError} <button type="button" onClick={()=>void refresh()}>Retry connection</button></p>}
    {(referenceLoading || referenceLoaded) && <p role="status" data-testid="artifact-arrival-count">{arrived} artifacts received{referenceLoading ? " · adding captured artifacts…" : " · complete"}</p>}
    {error && <p role="alert" className={styles.error}>{error}</p>}
    <section className={`${styles.panel} ${styles.compact}`} data-testid="reference-connection" data-load-state={referenceLoading ? "loading" : referenceLoaded ? "loaded" : "idle"}>
      <div className={styles.systemRow}>
        <span className={styles.statusDot} data-state={referenceLoaded ? "accepted" : "expiring"} />
        <strong>{referenceLoaded ? "Captured Online Boutique evidence loaded" : "Try the captured reference system"}</strong>
        <span className="pill">{referenceLoading ? "Loading" : referenceLoaded ? "Loaded" : "Historical capture"}</span>
        <span>{referenceLoaded ? CONNECTIONS.artifacts(artifactCount) : "—"}</span>
        {infoButton("reference", "the captured reference system")}
        {referenceLoaded ? <button className={connection ? undefined : styles.primary} type="button" onClick={()=>{if(connection){setSelected(connection.id);setSetupId(null);}onEvidence();}}>Open release evidence →</button> : <button className={connection ? undefined : styles.primary} type="button" disabled={busy || loading} onClick={() => void loadReference()}>{referenceLoading ? "Loading captured evidence…" : "Load captured Online Boutique evidence"}</button>}
      </div>
      {infoPanel("reference", <>
        {referenceLoaded && <><div className={styles.stats}><div><small>Observations</small><strong>{history.length}</strong><small>Captured {history.flatMap(h => h.checks.map(c => c.verdict.toUpperCase())).join(" + ")}</small></div><div><small>Release</small><strong className={styles.receipt}>#{receiptLabel(history[0]?.id ?? "")}</strong><small>{history[0] ? utcTime(history[0].run.observedAt,true) : ""}</small></div><div><small>Linked controls</small><strong>{linkedControls.size}</strong><small>{[...linkedControls].join(", ")}</small></div></div><p>Original timestamps kept. No upload credential issued. Evidence links are coverage, not control approval.</p><button type="button" onClick={()=>{if(connection){setSelected(connection.id);setSetupId(null);}onMap();}}>Open package map</button></>}
        {!referenceLoaded && <><p>Pinned public repository files and measured Online Boutique authorization results from a local Kubernetes test: the excessive permission and the operator-performed correction. Captured 5 Oct 2026, 10:54 p.m. Eastern (02:54 UTC, 6 Oct).</p><p className={styles.muted}>Measured by a separate Kubernetes Secrets reference script, not the downloadable HTTP collector. Loading keeps the original timestamps and issues no upload credential. No new scan or AI repair.</p></>}
        <div className={styles.downloads}><a href="/api/builder/reference?stage=before">↓ Download failed observation</a><a href="/api/builder/reference?stage=after">↓ Download corrected observation</a></div>
      </>)}
    </section>
    {onRecordedEvidence && <section className={`${styles.panel} ${styles.compact}`}><div className={styles.systemRow}><span className={styles.statusDot} data-state="accepted" /><strong>Podinfo · public source and recorded pipeline</strong><span className="pill">Pinned capture</span>{infoButton("podinfo", "Podinfo")}<button type="button" onClick={onRecordedEvidence}>Load captured Podinfo evidence</button></div>{infoPanel("podinfo", <p>Loads pinned repository files alongside the original pipeline and measured retest. Source declarations remain proposals; original pipeline timestamps and closure scope are preserved.</p>)}</section>}
    {!setupId && <section className={styles.panel} aria-labelledby="connect-title"><div className={styles.sectionTitle}><h2 id="connect-title">Connect a system</h2>{infoButton("connect", "connecting a system")}</div><form onSubmit={connect} className={styles.form}><label>System name<input required maxLength={100} value={name} onChange={e => setName(e.target.value)} placeholder="Enter system name" /></label><button disabled={busy}>{busy && !referenceLoading ? "Creating…" : "Create pipeline connection"}</button></form>{infoPanel("connect", <p className={styles.muted}>Creates a pipeline upload endpoint. You get an endpoint and a one-time upload credential for your CI job.</p>)}</section>}
    {connection && <>
      {!referenceLoaded && <div className={styles.systemRow}><span className={styles.statusDot} data-state={connection.revokedAt ? "rejected" : "accepted"} /><strong>{connection.name}</strong><span className={`pill ${connection.revokedAt ? "fail" : "pass"}`}>{connection.revokedAt ? "Revoked" : freshnessLabel(history[0]?.checks[0] ? checkState({run:history[0].run}, history[0].checks[0], store.now) : "unknown")}</span><span>{history.length}</span><label className={styles.systemPick}>System<select value={connection.id} onChange={e => { setSelected(e.target.value); setCredential(null); setReferenceLoaded(false); }}><option value="">Select a system</option>{connections.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label><button type="button" className={styles.primary} onClick={() => void refresh()}>↻ Refresh evidence</button><details className={styles.overflow}><summary aria-label={`More actions for ${connection.name}`}>⋯</summary><button type="button" disabled={busy || Boolean(connection.revokedAt)} onClick={() => void revoke()}>{connection.revokedAt ? "Upload credential revoked" : "Revoke upload credential"}</button></details></div>}
      {!referenceLoaded && <section className={styles.panel}><div className={styles.sectionTitle}><h2>Pipeline connection</h2><span className="pill">{credential?.id === connection.id ? "New" : connection.revokedAt ? "Upload credential revoked" : "Upload credential active"}</span></div><p role="status">{setupId ? <>Created connection: <strong>{connection.name}</strong>. Your current workspace is unchanged. <button type="button" className={styles.primary} onClick={()=>{setSelected(connection.id);setSetupId(null);}}>Switch to {connection.name} →</button></> : <>Selected workspace: <strong>{connection.name}</strong>. {history.length ? "Retained observations are available on Package map and Release evidence." : "No observations in this workspace yet. Publish or import a collector observation to begin."}</>}</p>      {credential?.id === connection.id ? <div className={styles.secret}><div className={styles.sectionTitle}><strong>One-time upload credential</strong><small>Shown once</small></div><div className={styles.row}><input aria-label="Connection credential" readOnly type={reveal ? "text" : "password"} value={credential.token} /><button type="button" aria-pressed={reveal} onClick={() => setReveal(!reveal)}>{reveal ? "Hide" : "Reveal"}</button><button type="button" onClick={() => void copy(credential.token, "credential")} aria-label="Copy credential">{copied === "credential" ? "Copied" : "Copy"}</button><button type="button" onClick={() => setCredential(null)} aria-label="Dismiss credential">Dismiss</button></div><p>Save this connection credential now as the masked CI secret <code>AEGIS_BUILDER_TOKEN</code>. It permits uploads to this connection and cannot download evidence.</p></div> : <p className={styles.muted}>Shown once when issued · cannot be revealed again.</p>}
      {!connection.revokedAt && <div className={styles.import}><strong>Or bring an event by hand</strong><label>Import collector event JSON<input type="file" accept=".json,application/json" disabled={busy} onChange={e => { void importEvent(e.currentTarget.files?.[0]); e.currentTarget.value = ""; }} /></label><small title="Reads the file and uploads it to this connection using your browser session. No GitHub or upload token required. Keep credentials out of artifacts.">Browser session upload · no GitHub or upload token required.</small></div>}
      </section>}
      {!referenceLoaded && <section className={styles.panel}><details><summary>Collect repository and pipeline files</summary><p>Pin each source commit, then run the source collector in your checkout. It reads configuration, manifests, workflows, documents and supplied scan or release files. It emits safe facts and importable events; raw files and secret values stay out of the binder.</p><code>npx tsx scripts/collect-evidence.ts sources.json evidence-output</code><p>Import each event file below or publish it to this connection's endpoint from CI. Missing scanner outputs remain missing evidence.</p></details></section>}
      {!referenceLoaded && <section className={styles.panel}><div className={styles.sectionTitle}><h2>Use this evidence in Binder</h2>{infoButton("use", "using this evidence")}</div>{infoPanel("use", <p>{history.length ? "Latest retained results feed the package map. Review the chain, scoped findings and mappings on Release evidence." : "No observations from this connection yet. They appear after the first CI upload. No security coverage is inferred."}</p>)}<div className={styles.row}><button disabled={!history.length} type="button" onClick={()=>{if(connection){setSelected(connection.id);setSetupId(null);}onMap();}}>Open package map</button><button disabled={!history.length} type="button" onClick={()=>{if(connection){setSelected(connection.id);setSetupId(null);}onEvidence();}}>Open release evidence →</button></div></section>}
      {!referenceLoaded && <section className={styles.panel}><details className={styles.setup} open={setupOpen} onToggle={e=>setSetupOpen(e.currentTarget.open)}><summary>Set up the first access check <small>HTTP collector · caller context + deployed revision</small></summary><p>Set CI variable <code>AEGIS_BUILDER_ENDPOINT</code> to</p><div className={styles.endpoint}><code>{endpoint}</code><button type="button" aria-label="Copy endpoint" onClick={() => void copy(endpoint, "endpoint")}>{copied === "endpoint" ? "Copied" : "Copy"}</button></div><p>HTTP 200 / 403 · assessed caller context · declared deployed revision</p><details className={styles.setupScope}><summary>Assessment scope</summary><p>Run from the caller context you intend to assess. This check measures HTTP 200 and HTTP 403 behavior; it does not establish general database, Kubernetes Secrets or firewall restrictions. The mapping you supply is a scoped claim for reviewer examination, not a full-control verdict.</p></details>
      {editSetup && <div className={styles.fields}><label>Required endpoint (expects 200)<input type="url" value={allowed} onChange={e => setAllowed(e.target.value)} placeholder="https://service/allowed-path" /></label><label>Prohibited endpoint (expects 403)<input type="url" value={denied} onChange={e => setDenied(e.target.value)} placeholder="https://service/restricted-path" /></label><label>Framework or policy<input value={framework} onChange={e => setFramework(e.target.value)} /></label><label>Requirement reference<input value={reference} onChange={e => setReference(e.target.value)} /></label><label>Exact assessment objective<input type="text" value={objective} onChange={e => setObjective(e.target.value)} /></label></div>}
      <div className={styles.downloads}><button type="button" onClick={config}>↓ Download check configuration</button><a href="/builder-evidence.mjs" download="builder-evidence.mjs">↓ Download Node collector</a><small>Commit both under <code>.aegis/</code> · Node 20 or later</small>{!editSetup && <button type="button" onClick={()=>setEditSetup(true)}>Edit check configuration</button>}</div>
      <div className={styles.ciPanel}><div className={styles.ciTabs}><button type="button" aria-pressed={job==="gitlab"} onClick={()=>setJob("gitlab")}>GitLab job</button><button type="button" aria-pressed={job==="github"} onClick={()=>setJob("github")}>GitHub workflow</button><small>{fullJob?"Full":"Excerpt"} · collects and publishes failures</small><button type="button" onClick={()=>{setFullJob(!fullJob);setEditSetup(fullJob);}}>{fullJob?"Back to excerpt":"Show full snippet"}</button><button type="button" onClick={()=>void copy(job==="gitlab"?gitlab:github,job)}>{copied===job?"Copied":"Copy full job"}</button></div><pre>{fullJob?(job==="gitlab"?gitlab:github):(job==="gitlab"?gitlab:github).split("\n").filter(line=>line.includes("check-access")||line.includes(" publish ")||line.includes("exit ")).join("\n")}</pre></div>
      <p>Set <code>AEGIS_SUBJECT_REVISION</code> to the deployed subject revision being assessed. Choose a runner with access to that environment. Failed and unknown observations publish before the job exits unsuccessfully. No AI API calls are made.</p></details></section>}
    </>}

    </div><aside className={styles.history} data-open={selectedEvent ? "1" : "0"} aria-label="Retained observation history"><div className={styles.sectionTitle}><h2>Retained observation history</h2><span className="pill">{history.length || "—"}</span></div>
    {(loading || referenceLoading) ? <p role="status">{referenceLoading ? "Adding captured observations…" : "Reading retained evidence…"}</p> : !history.length ? <div className={styles.empty}><strong>No pipeline connection observations yet</strong><p>This history covers collector observations retained by pipeline connections. Other workspace evidence remains available in Release evidence.</p></div> : <><p className={styles.muted}>A later PASS does not erase a failure or close its finding.</p>{history.map(h => {const verify=`node .aegis/builder-evidence.mjs verify --file evidence-${h.id}.json --expected-id ${h.id}`;return <details key={h.id} className={styles.historyCard} onToggle={event => setSelectedEvent(event.currentTarget.open ? h.id : null)}><summary>{h.checks.map(c => <span key={c.id} className={styles.check}><span className={`pill ${c.verdict === "fail" ? "fail" : c.verdict === "pass" ? "pass" : "miss"}`}>Captured {c.verdict.toUpperCase()}</span>{checkState({run:h.run},c,store.now) === "stale" && <span className="pill freshness-pill">Expired</span>}</span>)}<small>{utcTime(h.run.observedAt,true)}</small><strong>{h.run.id}</strong><small>{h.checks.map(c => `${c.id} · ${c.requirement.reference}`).join(", ")}</small></summary><dl><dt>Received</dt><dd>{utcTime(h.receivedAt)}</dd><dt>Producer</dt><dd>{h.run.producer} · unverified</dd>{h.checks.map(c => <div key={c.id}><dt>Valid until</dt><dd>{utcTime(c.validUntil)} · {freshnessLabel(checkState({run:h.run},c,store.now))}</dd></div>)}<dt>Receipt ID</dt><dd><code>{h.id}</code></dd></dl><a href={evidenceViewerHref(`/api/builder/evidence/${h.id}?connection=${connection?.id}`)} target="_blank" rel="noreferrer">Inspect retained evidence ↗</a><a href={`/api/builder/evidence/${h.id}?connection=${connection?.id}`}>↓ evidence-{receiptLabel(h.id)}.json</a><details><summary>Verify the retained bundle</summary><pre>{verify}</pre><button type="button" onClick={() => void copy(verify,h.id)}>{copied === h.id ? "Copied" : "Copy verify command"}</button><p>Checks digests only, not producer identity or security approval.</p></details><details><summary>Limitations and artifact digests</summary><ul>{h.limitations.map(l => <li key={l}>{l}</li>)}</ul><ul>{h.artifacts.map(a => <li key={a.name}>{a.name}<code>{a.sha256}</code></li>)}</ul></details></details>})}</>}
    </aside></div>
  </section>;
}
