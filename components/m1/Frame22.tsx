"use client";
import React, { useCallback, useEffect, useState } from "react";
import { F22, F25, KEPT, PERSON_NOT_RECORDED, DOT } from "@/lib/m1/copy";
import { exportDigest, exportFileLabel, formatPill, receiptDigest, storedTime, exportTime } from "@/lib/m1/format";
import { frame22State, frame22Targets, type Frame22State, type Result, type Stored } from "@/lib/m1/state";
import { M1RequestError, apiHeaders, apiPath, m1Href, m1Json, regenerateHref, workspaceViewHref, type Workspace } from "@/lib/m1/api";
import { M1Chrome, SideHonesty, StateCard, TitleBlock, type M1Header } from "./M1Chrome";

export type Frame22Props = {
  workspace: Workspace;
  source: string;
  state: Frame22State;
  objects: Stored[];
  results: Record<string, Result>;
  checkedAt: string | null;
  redownload: string | null;
  onRetry?: () => void;
  onRedownload?: () => void;
};

export function ExportRowHead({ object, children }: { object: Stored; children?: React.ReactNode }) {
  return <div className="m1-line12">
    <span className="m1-fmt">{formatPill(object.role)}</span>
    <span className="m1-code115" title={object.objectName}>{exportFileLabel(object.objectName, object.exportId)}</span>
    <b className="m1-pin">{object.exportId}</b>
    <span className="m1-tag">{exportTime(object.storedAt)}</span>
    <span className="m1-person">{PERSON_NOT_RECORDED}</span>
    <span className="m1-spacer" />
    {children}
  </div>;
}

/** Evidence id and store time, in the place the locked frame draws the release and received time. */
export function EvidenceLine({ object, children }: { object: Stored; children?: React.ReactNode }) {
  const at = storedTime(object.storedAt);
  return <span className="m1-hint">{F22.evidenceWord}<span className="m1-code">{object.evidenceId}</span>{at ? <>{F22.storedWord}<span className="m1-nowrap">{at}</span></> : F22.storeTimeMissing}{children}</span>;
}

function auditHref(workspace: Workspace, objectKey: string | undefined): string | null {
  return objectKey ? m1Href(workspace, "/stored/audit", { object: objectKey }) : null;
}

function EvidenceMismatch({ workspace, source, object, result, refused, redownload, onRedownload }: { workspace: Workspace; source: string; object: Stored; result: Result; refused: number; redownload: string | null; onRedownload?: () => void }) {
  const label = F22.evidenceLabel(object.controlId ?? "", source);
  return <div className="m1-body">
    <div className="m1-card" data-testid="m1-frame22-main">
      <div className="m1-split">
        <span className="m1-label">{label[0]}<span className="m1-nowrap">{label[1]}</span>{label[2]}</span>
        <span className="m1-note" data-testid="m1-refused-count">{F22.refusedCount(refused)}</span>
      </div>
      <div className="m1-refused">
        <div className="m1-line12"><b className="m1-name">{object.title}</b><span className="m1-tag">{object.filename}</span><span className="m1-spacer" /><span className="m1-pill stored">{F22.stored}</span><span className="m1-pill bad">{F22.readRefused}</span></div>
        <EvidenceLine object={object} />
        <div className="m1-banner bad">{F22.mismatch}</div>
        <div className="m1-digests">
          <span className="m1-muted">{F22.recorded}</span>
          <span className="m1-flex"><span className="m1-code12" data-testid="m1-recorded">{receiptDigest(result.recordedDigest)}</span><span className="m1-note">{F22.atStore}</span></span>
          <span className="m1-muted">{F22.recomputed}</span>
          <span className="m1-flex"><span className="m1-code12-bad" data-testid="m1-recomputed">{receiptDigest(result.recomputedDigest)}</span></span>
        </div>
        <span className="m1-strong">{KEPT}</span>
        <span className="m1-detail">{F22.stays(object.filename, object.controlId ?? "")}</span>
      </div>
    </div>
    <aside className="m1-side">
      <span className="m1-label">{F22.whatYouCanDo}</span>
      <div className="m1-col4"><button type="button" className="m1-btn" onClick={onRedownload}>{F22.redownload}</button><span className="m1-help">{F22.redownloadHint}</span>{redownload && <span className="m1-help" role="status">{redownload}</span>}</div>
      <div className="m1-col4"><a className="m1-btn" href={auditHref(workspace, object.objectKey) ?? undefined}>{F22.openAudit}</a><span className="m1-help">{F22.openAuditHint}</span></div>
      <div className="m1-col4"><a className="m1-btn" href={regenerateHref(workspace, object)} data-testid="m1-link-regenerate">{F22.regenerate}</a><span className="m1-help">{F22.regenerateOff}</span></div>
      <SideHonesty />
    </aside>
  </div>;
}

function ExportMismatch({ workspace, object, result }: { workspace: Workspace; object: Stored; result: Result }) {
  return <StateCard name="export-mismatch">
    <ExportRowHead object={object}><span className="m1-pill bad">{F22.readRefused}</span></ExportRowHead>
    <div className="m1-banner bad">{F22.mismatch}</div>
    <div className="m1-digests">
      <span className="m1-muted">{F22.recorded}</span>
      <span className="m1-flex"><span className="m1-code12" data-testid="m1-recorded">{exportDigest(result.recordedDigest)}</span></span>
      <span className="m1-muted">{F22.recomputed}</span>
      <span className="m1-flex"><span className="m1-code12-bad" data-testid="m1-recomputed">{exportDigest(result.recomputedDigest)}</span></span>
    </div>
    <span className="m1-strong">{KEPT}</span>
    <div className="m1-buttons">
      <a className="m1-btn primary" href={regenerateHref(workspace, object)} data-testid="m1-link-regenerate">{F22.regenerate}</a>
      <a className="m1-btn" href={auditHref(workspace, object.objectKey) ?? undefined}>{F22.openAudit}</a>
      <button type="button" className="m1-btn" disabled>{F22.exportRedownload}</button>
    </div>
    <span className="m1-small">{F22.exportRedownloadOff(object.exportId ?? "")}</span>
  </StateCard>;
}

function FileRow({ object, children }: { object: Stored; children: React.ReactNode }) {
  if (object.kind === "evidence") {
    return <div className="m1-filerow" data-testid="m1-file-row"><b className="m1-name" title={object.title}>{object.title}</b><span className="m1-tag" title={object.filename}>{object.filename}</span><span className="m1-spacer" />{children}</div>;
  }
  const label = exportFileLabel(object.objectName, object.exportId);
  return <div className="m1-filerow" data-testid="m1-file-row"><span className="m1-fmt">{formatPill(object.role)}</span><span className="m1-code115 m1-export-name" title={object.objectName}>{label}</span><b className="m1-pin">{object.exportId}</b><span className="m1-spacer" />{children}</div>;
}

function digestFor(object: Stored): React.ReactNode {
  return object.kind === "evidence"
    ? <span className="m1-flex6"><span className="m1-code11">{receiptDigest(object.recordedDigest)}</span></span>
    : <span className="m1-flex6"><span className="m1-code11-plain">{exportDigest(object.recordedDigest)}</span></span>;
}

function AllMatch({ workspace, rows, checkedAt }: { workspace: Workspace; rows: Array<{ object: Stored; result: Result }>; checkedAt: string | null }) {
  return <StateCard name="all-match">
    <div className="m1-banner ok flex"><span>{rows.every(row => row.result.status === "match") ? F22.allMatch : "Some files could not be compared"}</span><span className="m1-spacer" /><span className="m1-nowrap" style={{ fontSize: 11, fontWeight: 600 }}>{F22.lastCheck(storedTimeShort(checkedAt))}</span></div>
    {rows.map(({ object, result }) => <FileRow key={object.objectKey} object={object}>{digestFor(object)}<span className={`m1-pill ${result.status === "match" ? "ok" : "neutral"}`}>{result.status === "match" ? F22.matches : result.status === "unverified" ? "No recorded digest" : F25.rowUnreadable}</span>{object.kind === "export" && object.current && <a className="m1-row-regenerate" href={regenerateHref(workspace, object)} data-testid="m1-link-regenerate">{F22.regenerate}</a>}</FileRow>)}
  </StateCard>;
}

function storedTimeShort(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  const two = (n: number) => String(n).padStart(2, "0");
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${two(date.getUTCHours())}:${two(date.getUTCMinutes())} UTC ${DOT} ${date.getUTCDate()} ${months[date.getUTCMonth()]}`;
}

function Loading({ targets, results }: { targets: Stored[]; results: Record<string, Result> }) {
  const current = targets.find((item) => !results[item.objectKey])?.objectKey;
  return <StateCard name="loading">
    <div className="m1-banner busy" role="status">{F22.verifying}</div>
    {targets.map((object, index) => {
      const result = results[object.objectKey];
      return <FileRow key={object.objectKey} object={object}>
        {result ? <>{digestFor(object)}<span className={`m1-pill ${result.status === "match" ? "ok" : result.status === "mismatch" ? "bad" : "neutral"}`}>{result.status === "match" ? F22.matches : result.status === "mismatch" ? F22.readRefused : F25.rowUnreadable}</span></>
          : <><span className="m1-flex6"><span className="m1-skel" style={{ width: index === 0 ? 160 : 120 }} /></span><span className="m1-hint">{object.objectKey === current ? F22.checking : F22.waiting}</span></>}
      </FileRow>;
    })}
    <div className="m1-row"><button type="button" className="m1-btn" disabled>{F22.download}</button><span className="m1-small">{F22.readsWait}</span></div>
  </StateCard>;
}

function ErrorCard({ workspace, objectKey, onRetry }: { workspace: Workspace; objectKey: string | undefined; onRetry?: () => void }) {
  const audit = auditHref(workspace, objectKey);
  return <StateCard name="error">
    <div className="m1-banner bad" role="alert">{F22.couldNotRun}</div>
    <span className="m1-body-text">{F22.couldNotRunBody}</span>
    <span className="m1-strong">{KEPT}</span>
    <div className="m1-buttons">
      <button type="button" className="m1-btn primary" onClick={onRetry}>{F22.retry}</button>
      {audit ? <a className="m1-btn" href={audit}>{F22.openAudit}</a> : <button type="button" className="m1-btn" disabled>{F22.openAudit}</button>}
    </div>
  </StateCard>;
}

function Empty({ workspace }: { workspace: Workspace }) {
  return <StateCard name="empty">
    <span className="m1-empty-title">{F25.empty}</span>
    <span className="m1-body-text">{F25.emptyBody}</span>
    <div className="m1-row"><a className="m1-btn" href={workspaceViewHref(workspace, "export")}>{F25.backExports}</a></div>
  </StateCard>;
}

export function Frame22View(props: Frame22Props) {
  const { workspace, source, state } = props;
  const firstKey = props.objects[0]?.objectKey;
  let body: React.ReactNode;
  if (state.kind === "evidence-mismatch") {
    body = <EvidenceMismatch workspace={workspace} source={source} object={state.object} result={state.result} refused={state.refused} redownload={props.redownload} onRedownload={props.onRedownload} />;
  } else {
    let card: React.ReactNode;
    if (state.kind === "export-mismatch") card = <ExportMismatch workspace={workspace} object={state.object} result={state.result} />;
    else if (state.kind === "all-match") card = <AllMatch workspace={workspace} rows={state.rows} checkedAt={props.checkedAt} />;
    else if (state.kind === "error") card = <ErrorCard workspace={workspace} objectKey={firstKey} onRetry={props.onRetry} />;
    else if (state.kind === "empty") card = <Empty workspace={workspace} />;
    else card = <Loading targets={frame22Targets(props.objects, null).length ? frame22Targets(props.objects, null) : props.objects} results={props.results} />;
    body = <div className="m1-body"><div className="m1-left">{card}</div></div>;
  }
  return <main className="m1-main" data-testid="m1-frame22" data-state={state.kind}>
    <TitleBlock title={F22.title} chip={F22.chip} subtitle={F22.subtitle(source)} />
    {body}
  </main>;
}

export function StoredEvidenceScreen({ workspace, header, buildSha, focus }: { workspace: Workspace; header: M1Header; buildSha: string; focus: string | null }) {
  const [objects, setObjects] = useState<Stored[] | null>(null);
  const [results, setResults] = useState<Record<string, Result>>({});
  const [failed, setFailed] = useState(false);
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  const [redownload, setRedownload] = useState<string | null>(null);
  const load = useCallback(async () => {
    setObjects(null); setResults({}); setFailed(false); setRedownload(null);
    try {
      const inventory = await m1Json<{ objects: Stored[] }>(workspace, "/api/digest/stored");
      setObjects(inventory.objects);
      for (const target of frame22Targets(inventory.objects, focus)) {
        const checked = await m1Json<{ result: Result }>(workspace, "/api/digest/verify", { method: "POST", body: { objectKey: target.objectKey } });
        setResults((previous) => ({ ...previous, [target.objectKey]: checked.result }));
      }
      setCheckedAt(new Date().toISOString());
    } catch {
      setFailed(true);
    }
  }, [workspace, focus]);
  useEffect(() => { void load(); }, [load]);
  const state = frame22State({ objects, results, focus, failed });
  async function readAgain(object: Stored) {
    if (!object.controlId || !object.evidenceId) return;
    try {
      const response = await fetch(apiPath(workspace, `/api/controls/${encodeURIComponent(object.controlId)}/evidence/${encodeURIComponent(object.evidenceId)}/bytes`), { cache: "no-store", credentials: "same-origin", headers: apiHeaders(workspace) });
      if (response.ok) {
        const url = URL.createObjectURL(await response.blob());
        const link = document.createElement("a");
        link.href = url; link.download = object.filename; link.click();
        URL.revokeObjectURL(url);
        setRedownload(null);
        return;
      }
      const body = await response.json().catch(() => null) as { error?: { code?: string; details?: { refusedAt?: string } } } | null;
      if (body?.error?.code === "DIGEST_MISMATCH") setRedownload(F22.redownloadRefused(storedTime(body.error.details?.refusedAt ?? null) ?? ""));
      else throw new M1RequestError(response.status, null);
    } catch {
      setRedownload(F22.redownloadFailed);
    }
  }
  return <M1Chrome header={header} tab="release" workspace={workspace} buildSha={buildSha} testId="m1-screen">
    <Frame22View workspace={workspace} source={header?.workspaceName ?? ""} state={state} objects={objects ?? []} results={results} checkedAt={checkedAt} redownload={redownload}
      onRetry={() => void load()} onRedownload={() => { if (state.kind === "evidence-mismatch") void readAgain(state.object); }} />
  </M1Chrome>;
}
