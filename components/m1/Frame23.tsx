"use client";
import React, { useCallback, useEffect, useState } from "react";
import { F22, F23, KEPT, PERSON_NOT_RECORDED } from "@/lib/m1/copy";
import { auditTime, entryTime, exportDigest, exportFileLabel, formatPill, receiptDigest, shortDigest } from "@/lib/m1/format";
import { frame23State, type AuditEntry, type Frame23State, type Stored } from "@/lib/m1/state";
import { m1Href, m1Json, workspaceViewHref, type Workspace } from "@/lib/m1/api";
import { M1Chrome, SideHonesty, StateCard, TitleBlock, type M1Header } from "./M1Chrome";
import { EvidenceLine } from "./Frame22";

type Filter = "all" | "reads" | "refused";

export type Frame23Props = {
  workspace: Workspace;
  source: string;
  state: Frame23State;
  filter: Filter;
  selected: string | null;
  onFilter?: (filter: Filter) => void;
  onSelect?: (id: string) => void;
  onRetry?: () => void;
  /** Shown in the loading and error cards while the object is known but its trail is not. */
  pending: Stored | null;
};

function EvidenceSummary({ object, source }: { object: Stored; source: string }) {
  return <div className="m1-summary">
    <div className="m1-flex"><b className="m1-summary-name">{object.title}</b><span className="m1-tag-bold">{object.filename}</span><span className="m1-spacer" /><span className="m1-pill stored">{F23.stored}</span></div>
    <EvidenceLine object={object}>{" \u00b7 "}<span className="m1-nowrap">{object.controlId}</span>{` \u00b7 ${source}`}</EvidenceLine>
    <span className="m1-flex"><span className="m1-hint">{F22.recorded}</span><span className="m1-code12" style={{ fontWeight: 700 }} data-testid="m1-recorded">{receiptDigest(object.recordedDigest)}</span><span className="m1-note">{F22.atStore}</span></span>
  </div>;
}

function ExportSummary({ object }: { object: Stored }) {
  return <div className="m1-summary">
    <div className="m1-flex"><span className="m1-fmt">{formatPill(object.role)}</span><span className="m1-code12" style={{ fontWeight: 700 }} title={object.objectName}>{exportFileLabel(object.objectName, object.exportId)}</span><b className="m1-code12-plain">{object.exportId}</b></div>
    <span className="m1-flex"><span className="m1-hint">{F22.recorded}</span><span className="m1-code12" style={{ fontWeight: 700 }} data-testid="m1-recorded">{exportDigest(object.recordedDigest)}</span></span>
  </div>;
}

type Row = { id: string; kind: "stored" | "refused"; at: string | null; entry?: AuditEntry };

function rowsFor(object: Stored, entries: AuditEntry[]): Row[] {
  return [{ id: "stored", kind: "stored", at: object.storedAt }, ...entries.map((entry) => ({ id: entry.id, kind: "refused" as const, at: entry.refusedAt, entry }))];
}

function EvidenceTrail({ workspace, source, object, entries, filter, selected, onFilter, onSelect }: { workspace: Workspace; source: string; object: Stored; entries: AuditEntry[]; filter: Filter; selected: string | null; onFilter?: (f: Filter) => void; onSelect?: (id: string) => void }) {
  const rows = rowsFor(object, entries);
  const visible = rows.filter((row) => filter === "all" || (filter === "refused" && row.kind === "refused"));
  const chosen = rows.find((row) => row.id === selected) ?? rows[rows.length - 1] as Row;
  return <div className="m1-body">
    <div className="m1-card" data-testid="m1-frame23-main">
      <EvidenceSummary object={object} source={source} />
      <div className="m1-row">
        <div className="m1-seg" role="group" aria-label="Filter entries">
          {(["all", "reads", "refused"] as const).map((id) => <button key={id} type="button" aria-pressed={filter === id} onClick={() => onFilter?.(id)}>{id === "all" ? F23.all : id === "reads" ? F23.reads : F23.refused}</button>)}
        </div>
        <span className="m1-spacer" />
        <span className="m1-hint">{F23.appendOnly}</span>
      </div>
      <div className="m1-audit-head"><span className="m1-label">{F23.event}</span><span className="m1-label">{F23.detail}</span><span className="m1-label">{F23.utc}</span><span className="m1-label">{F23.by}</span></div>
      <div role="list" aria-label="Audit entries" className="m1-list">
        {visible.map((row) => <button key={row.id} role="listitem" type="button" className="m1-audit-row" aria-pressed={row.id === chosen.id} data-testid="m1-audit-row" data-kind={row.kind} onClick={() => onSelect?.(row.id)} style={{ width: "100%", boxSizing: "border-box" }}>
          <span className="m1-block"><span className={`m1-pill ${row.kind === "stored" ? "stored" : "bad"}`}>{row.kind === "stored" ? F23.stored : F23.readRefused}</span></span>
          {row.kind === "stored"
            ? <span className="m1-cell"><span>{F23.storedDetail}</span><span className="m1-flex6"><span className="m1-hint">{F23.digestAtStore}</span><span className="m1-code11">{shortDigest(object.recordedDigest)}</span></span></span>
            : <span className="m1-cell"><span>{F23.refusedDetail}</span><span className="m1-flex6"><span className="m1-hint">{F23.recorded}</span><span className="m1-code11">{shortDigest(row.entry?.recordedDigest)}</span></span><span className="m1-flex6"><span className="m1-hint">{F23.recomputed}</span><span className="m1-code11-bad">{shortDigest(row.entry?.recomputedDigest)}</span></span></span>}
          <span className="m1-cell-start"><span className="m1-code11" data-testid="m1-audit-time">{auditTime(row.at, row.kind === "stored") ?? ""}</span></span>
          <span className="m1-by" data-testid="m1-audit-by">{PERSON_NOT_RECORDED}</span>
        </button>)}
      </div>
    </div>
    <aside className="m1-side tight">
      <span className="m1-label">{F23.selected}</span>
      <div className="m1-flex"><span className={`m1-pill ${chosen.kind === "stored" ? "stored" : "bad"}`}>{chosen.kind === "stored" ? F23.stored : F23.readRefused}</span></div>
      <div className="m1-facts">
        <span className="m1-muted">{F23.recordedCap}</span><span className="m1-code11">{receiptDigest(chosen.entry?.recordedDigest ?? object.recordedDigest)}</span>
        {chosen.entry && <><span className="m1-muted">{F23.recomputedCap}</span><span className="m1-code11-bad">{receiptDigest(chosen.entry.recomputedDigest)}</span></>}
        <span className="m1-muted">{F23.when}</span><span className="m1-code11">{entryTime(chosen.at) ?? ""}</span>
        <span className="m1-muted">{F23.byCap}</span><span>{PERSON_NOT_RECORDED}</span>
      </div>
      <span className="m1-help">{chosen.kind === "refused" ? F23.refusedNote : F23.storedNote}</span>
      <span className="m1-strong">{KEPT}</span>
      <div className="m1-col4"><a className="m1-btn" href={m1Href(workspace, "/stored/evidence", { object: object.objectKey })}>{F23.backEvidence}</a></div>
      <SideHonesty />
    </aside>
  </div>;
}

function BackLink({ workspace, object }: { workspace: Workspace; object: Stored | null }) {
  if (object?.kind === "export") return <div className="m1-block"><a className="m1-btn" href={workspaceViewHref(workspace, "export")}>{F23.backExports}</a></div>;
  return <div className="m1-block"><a className="m1-btn" href={m1Href(workspace, "/stored/evidence", { object: object?.objectKey })}>{F23.backEvidence}</a></div>;
}

function ExportCard({ workspace, object, entries, next }: { workspace: Workspace; object: Stored; entries: AuditEntry[]; next: Stored | null }) {
  return <StateCard name="export">
    <ExportSummary object={object} />
    <span className="m1-hint">{F23.exportNote}</span>
    <div className="m1-trail-row" data-testid="m1-audit-row" data-kind="stored">
      <span className="m1-block"><span className="m1-pill stored">{F23.stored}</span></span>
      <span style={{ minWidth: 0 }}>{F23.storedRow(exportDigest(object.recordedDigest))[0]}<span className="m1-mono">{exportDigest(object.recordedDigest)}</span></span>
      <span className="m1-code11">{auditTime(object.storedAt) ?? ""}</span>
    </div>
    {entries.map((entry) => {
      const parts = F23.refusedRow(exportDigest(entry.recordedDigest), exportDigest(entry.recomputedDigest));
      return <div key={entry.id} className="m1-trail-row" data-testid="m1-audit-row" data-kind="refused">
        <span className="m1-block"><span className="m1-pill bad">{F23.readRefused}</span></span>
        <span style={{ minWidth: 0 }}>{parts[0]}<span className="m1-mono">{parts[1]}</span>{parts[2]}<span className="m1-code-bad">{parts[3]}</span></span>
        <span className="m1-code11" data-testid="m1-audit-time">{auditTime(entry.refusedAt) ?? ""}</span>
      </div>;
    })}
    {next && <div className="m1-trail-row" data-testid="m1-audit-row" data-kind="regenerated">
      <span className="m1-block"><span className="m1-pill warn">{F23.regenerated}</span></span>
      <span style={{ minWidth: 0 }}>{next.role === "oscal" ? <>New export <span className="m1-code">{next.exportId}</span>{" \u00b7 "}<span className="m1-code">{object.exportId}</span> kept</> : <>{F23.regeneratedDetail("")[0]}<span className="m1-code">{exportFileLabel(next.objectName, next.exportId)}</span>{F23.regeneratedDetail("")[2]}</>}</span>
      <span className="m1-code11">{auditTime(object.keptAt) ?? ""}</span>
    </div>}
    <BackLink workspace={workspace} object={object} />
  </StateCard>;
}

function Summary({ object, source }: { object: Stored | null; source: string }) {
  if (!object) return null;
  return object.kind === "export" ? <ExportSummary object={object} /> : <EvidenceSummary object={object} source={source} />;
}

export function Frame23View(props: Frame23Props) {
  const { workspace, source, state } = props;
  let body: React.ReactNode;
  if (state.kind === "evidence") {
    body = <EvidenceTrail workspace={workspace} source={source} object={state.object} entries={state.entries} filter={props.filter} selected={props.selected} onFilter={props.onFilter} onSelect={props.onSelect} />;
  } else {
    let card: React.ReactNode;
    if (state.kind === "export") card = <ExportCard workspace={workspace} object={state.object} entries={state.entries} next={state.next} />;
    else if (state.kind === "evidence-empty") card = <StateCard name="evidence-empty">
      <EvidenceSummary object={state.object} source={source} />
      <div className="m1-trail-row" data-testid="m1-audit-row" data-kind="stored">
        <span className="m1-block"><span className="m1-pill stored">{F23.stored}</span></span>
        <span style={{ minWidth: 0 }}>{`${F23.storedDetail} \u00b7 ${PERSON_NOT_RECORDED}`}</span>
        <span className="m1-code11">{auditTime(state.object.storedAt, true) ?? ""}</span>
      </div>
      <span style={{ fontSize: 12, color: "rgb(74, 70, 104)" }}>{F23.neverRefused}</span>
      <BackLink workspace={workspace} object={state.object} />
    </StateCard>;
    else if (state.kind === "error") card = <StateCard name="error">
      <Summary object={props.pending} source={source} />
      <div className="m1-banner bad" role="alert">{F23.error}</div>
      <span className="m1-body-text">{F23.errorBody}</span>
      <div className="m1-buttons"><button type="button" className="m1-btn primary" onClick={props.onRetry}>{F23.retry}</button><BackLink workspace={workspace} object={props.pending} /></div>
    </StateCard>;
    else if (state.kind === "missing") card = <StateCard name="missing">
      <span className="m1-empty-title">{F23.notFound}</span>
      <BackLink workspace={workspace} object={null} />
    </StateCard>;
    else card = <StateCard name="loading">
      <Summary object={props.pending} source={source} />
      <span className="m1-loading-text" role="status">{F23.loading}</span>
      {[0, 1, 2].map((index) => <div key={index} className="m1-trail-skel"><span className="m1-skel" style={{ width: 90 }} /><span className="m1-skel" style={{ width: "70%" }} /><span className="m1-skel" style={{ width: 90 }} /></div>)}
      <div className="m1-row"><button type="button" className="m1-btn" disabled>{F23.filtersOff}</button><span className="m1-help">{F23.filtersWait}</span></div>
    </StateCard>;
    body = <div className="m1-body"><div className="m1-left">{card}</div></div>;
  }
  return <main className="m1-main" data-testid="m1-frame23" data-state={state.kind}>
    <TitleBlock title={F23.title} chip={F23.chip} subtitle={F23.subtitle} />
    {body}
  </main>;
}

export function AuditTrailScreen({ workspace, header, buildSha, focus }: { workspace: Workspace; header: M1Header; buildSha: string; focus: string | null }) {
  const [objects, setObjects] = useState<Stored[] | null>(null);
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [selected, setSelected] = useState<string | null>(null);
  const load = useCallback(async () => {
    setFailed(false); setEntries(null);
    try {
      const inventory = await m1Json<{ objects: Stored[] }>(workspace, "/api/digest/stored");
      setObjects(inventory.objects);
      const target = focus ?? defaultFocus(inventory.objects);
      if (!target || !inventory.objects.some((item) => item.objectKey === target)) return;
      // An absent refusal is normal. The detail endpoint intentionally keeps its
      // PR 54 404 contract; the list endpoint represents absence without an error.
      const trail = await m1Json<{ refusals: Array<{ objectKey: string; entries: AuditEntry[] }>; truncated: boolean }>(workspace, "/api/digest/refusals");
      const group = trail.refusals.find((item) => item.objectKey === target);
      // A capped list cannot establish absence for an object outside the cap.
      if (!group && trail.truncated) throw new Error("The refusal list was truncated before this object's trail could be established.");
      setEntries(group?.entries ?? []);
    } catch {
      setFailed(true);
    }
  }, [workspace, focus]);
  useEffect(() => { void load(); }, [load]);
  const resolvedFocus = focus ?? defaultFocus(objects);
  const state = frame23State({ objects, focus: resolvedFocus, entries, failed });
  const pending = objects?.find((item) => item.objectKey === resolvedFocus) ?? null;
  return <M1Chrome header={header} tab="release" workspace={workspace} buildSha={buildSha} testId="m1-screen">
    <Frame23View workspace={workspace} source={header?.workspaceName ?? ""} state={state} filter={filter} selected={selected} onFilter={setFilter} onSelect={setSelected} onRetry={() => void load()} pending={pending} />
  </M1Chrome>;
}

function defaultFocus(objects: Stored[] | null): string | null {
  return objects?.filter(item => item.role === "oscal" && item.current).sort((a, b) => (b.storedAt ?? "").localeCompare(a.storedAt ?? ""))[0]?.objectKey ?? objects?.find(item => item.kind === "evidence")?.objectKey ?? null;
}
