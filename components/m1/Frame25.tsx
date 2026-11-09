"use client";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { F22, F25, KEPT } from "@/lib/m1/copy";
import { checkTime, exportDigest, exportFileLabel, shortDigest } from "@/lib/m1/format";
import { frame25State, type Counts, type Frame25State, type Result, type Stored } from "@/lib/m1/state";
import { m1Href, m1Json, regenerateHref, workspaceViewHref, type Workspace } from "@/lib/m1/api";
import { M1Chrome, SideHonesty, StateCard, TitleBlock, type M1Header } from "./M1Chrome";

export type Frame25Props = {
  workspace: Workspace;
  state: Frame25State;
  objects: Stored[];
  onRun?: () => void;
};

const ROLE_ORDER: Record<string, number> = { evidence: 0, oscal: 1, word: 2, excel: 3 };

/** Evidence first, then exports newest first, each export as XML, DOCX, XLSX with the current file before kept ones. */
export function verifyRows(results: Result[], objects: Stored[]): Array<{ result: Result; object: Stored | null }> {
  const byKey = new Map(objects.map((item) => [item.objectKey, item]));
  return results
    .map((result) => ({ result, object: byKey.get(result.objectKey) ?? null }))
    .sort((a, b) => {
      const ak = a.result.kind === "evidence" ? 0 : 1;
      const bk = b.result.kind === "evidence" ? 0 : 1;
      if (ak !== bk) return ak - bk;
      const ae = a.object?.exportId ?? "";
      const be = b.object?.exportId ?? "";
      if (ae !== be) return be.localeCompare(ae);
      const ar = ROLE_ORDER[a.object?.role ?? ""] ?? 9;
      const br = ROLE_ORDER[b.object?.role ?? ""] ?? 9;
      if (ar !== br) return ar - br;
      return Number(b.object?.current ?? false) - Number(a.object?.current ?? false);
    });
}

function LastCheck({ checkedAt }: { checkedAt: string }) {
  return <span className="m1-flex6"><span className="m1-hint">{F25.lastFull}</span><span className="m1-tag-plain" data-testid="m1-last-check">{checkTime(checkedAt)}</span></span>;
}

function RunAgain({ onRun }: { onRun?: () => void }) {
  return <button type="button" className="m1-btn" onClick={onRun} data-testid="m1-run">{F25.runAgain}</button>;
}

function CountBox({ value, label, tone, testId }: { value: number; label: string; tone?: "ok" | "bad"; testId: string }) {
  return <div className="m1-count"><b className={tone} data-testid={testId}>{value}</b><span className="m1-small">{label}</span></div>;
}

function ResultPill({ status }: { status: Result["status"] }) {
  if (status === "match") return <span className="m1-pill ok">{F25.rowMatch}</span>;
  if (status === "mismatch") return <span className="m1-pill bad">{F25.rowMismatch}</span>;
  return <span className="m1-pill neutral">{status === "unverified" ? "No recorded digest" : F25.rowUnreadable}</span>;
}

function VerifyRow({ workspace, result, object }: { workspace: Workspace; result: Result; object: Stored | null }) {
  const evidence = result.kind === "evidence";
  const bad = result.status === "mismatch";
  return <div className={`m1-verify-row${bad ? " m1-verify-bad" : ""}`} data-testid="m1-verify-row" data-status={result.status} data-kind={result.kind} data-object={result.objectKey}>
    <span className="m1-verify-file">
      {evidence
        ? <><b className="m1-name">{object?.title ?? result.objectName}</b><span className="m1-tag-plain" title={object?.filename}>{object?.filename ?? ""}</span></>
        : <><span className="m1-tag-plain" title={object?.objectName ?? result.objectName}>{exportFileLabel(object?.objectName ?? result.objectName, object?.exportId ?? null)}</span><b className="m1-tag-plain" style={{ fontWeight: 700 }}>{object?.exportId}</b></>}
    </span>
    <span className="m1-small">{evidence ? F25.evidence : F25.exportKind}</span>
    <span className="m1-flex6"><span className="m1-tag-plain" title={result.recordedDigest ?? "No recorded digest"}>{evidence ? shortDigest(result.recordedDigest) : exportDigest(result.recordedDigest)}</span></span>
    <span className="m1-block" title={`${F22.recomputed}: ${result.recomputedDigest ?? (result.status === "unverified" ? "No recorded digest" : F25.rowUnreadable)}`}><ResultPill status={result.status} /></span>
    <span className="m1-verify-links">
      {bad && <>
        <a href={m1Href(workspace, "/stored/evidence", { object: result.objectKey })} data-testid="m1-link-refused">{F25.readRefused}</a>
        <a href={m1Href(workspace, "/stored/audit", { object: result.objectKey })} data-testid="m1-link-audit">{F25.auditTrail}</a>
      </>}
      {object && (object.current || evidence || bad) && <a href={regenerateHref(workspace, object)} data-testid="m1-link-regenerate">{F22.regenerate}</a>}
    </span>
  </div>;
}

function Results({ workspace, counts, checkedAt, results, objects, onRun, allMatch = false }: { workspace: Workspace; counts: Counts; checkedAt: string; results: Result[]; objects: Stored[]; onRun?: () => void; allMatch?: boolean }) {
  return <div className="m1-body">
    <div className="m1-card" data-testid="m1-frame25-main">
      <div className="m1-row">
        {allMatch ? <span className="m1-banner ok slim" data-testid="m1-all-match">{F25.allMatch(counts.checked)}</span> : <span className="m1-label">{F25.result}</span>}
        <span className="m1-spacer" />
        <LastCheck checkedAt={checkedAt} />
        <RunAgain onRun={onRun} />
      </div>
      <div className="m1-counts">
        <CountBox value={counts.checked} label={F25.filesChecked} testId="m1-count-checked" />
        <CountBox value={counts.match} label={F25.match} tone="ok" testId="m1-count-match" />
        <CountBox value={counts.mismatch} label={F25.mismatch} tone="bad" testId="m1-count-mismatch" />
        <CountBox value={counts.unreadable} label={F25.unreadable} testId="m1-count-unreadable" />
      </div>
      <div className="m1-verify-head"><span className="m1-label">{F25.file}</span><span className="m1-label">{F25.kind}</span><span className="m1-label">{F25.recorded}</span><span className="m1-label">{F25.resultCol}</span><span className="m1-label" /></div>
      <div role="list" aria-label="Stored files" className="m1-list">
        {verifyRows(results, objects).map(({ result, object }) => <div role="listitem" key={result.objectKey}><VerifyRow workspace={workspace} result={result} object={object} /></div>)}
      </div>
      {counts.unverified > 0 && <span className="m1-help" data-testid="m1-unverified">{F25.unverified(counts.unverified)}</span>}
    </div>
    <aside className="m1-side">
      <span className="m1-label">{F25.whatChecks}</span>
      <span className="m1-help">{F25.checks1}</span>
      <span className="m1-help">{F25.checks2}</span>
      <span className="m1-strong">{KEPT}</span>
      <span className="m1-label">{F25.notIncluded}</span>
      <span className="m1-help">{F25.notIncludedBody}</span>
      <SideHonesty />
    </aside>
  </div>;
}

export function Frame25View({ workspace, state, objects, onRun }: Frame25Props) {
  let body: React.ReactNode;
  if (state.kind === "results" || state.kind === "all-match") {
    body = <Results workspace={workspace} counts={state.counts} checkedAt={state.checkedAt} results={state.results} objects={objects} onRun={onRun} allMatch={state.kind === "all-match"} />;
  } else {
    let card: React.ReactNode;
    if (state.kind === "empty") card = <StateCard name="empty">
      <span className="m1-empty-title">{F25.empty}</span>
      <span className="m1-body-text">{F25.emptyBody}</span>
      <div className="m1-row"><button type="button" className="m1-btn" disabled>{F25.verify}</button><span className="m1-help">{F25.emptyOff}</span></div>
    </StateCard>;
    else if (state.kind === "error") card = <StateCard name="error">
      <div className="m1-banner bad" role="alert">{F25.error}</div>
      <span className="m1-body-text">{F25.errorBody}</span>
      <span className="m1-strong">{KEPT}</span>
      <div className="m1-buttons"><button type="button" className="m1-btn primary" onClick={onRun}>{F25.retry}</button><a className="m1-btn" href={workspaceViewHref(workspace, "export")}>{F25.backExports}</a></div>
    </StateCard>;
    else {
      const width = state.total > 0 ? `${Math.round((state.done / state.total) * 100)}%` : "0%";
      card = <StateCard name="loading">
        <span className="m1-run-title" role="status" data-testid="m1-progress">{F25.progress(state.done, state.total)}</span>
        <span className="m1-bar" aria-hidden="true"><span style={{ width }} /></span>
        <span className="m1-body-text">{F25.progressBody}</span>
        <div className="m1-row"><button type="button" className="m1-btn" disabled>{F25.runAgain}</button><span className="m1-help">{F25.offWhile}</span></div>
      </StateCard>;
    }
    body = <div className="m1-body"><div className="m1-left">{card}</div></div>;
  }
  return <main className="m1-main" data-testid="m1-frame25" data-state={state.kind}>
    <TitleBlock title={F25.title} chip={F25.chip} subtitle={F25.subtitle} />
    {body}
  </main>;
}

type Check = { checkedAt: string | null; results: Result[] | null };

export function VerifyStoredScreen({ workspace, header, buildSha }: { workspace: Workspace; header: M1Header; buildSha: string }) {
  const [objects, setObjects] = useState<Stored[] | null>(null);
  const [check, setCheck] = useState<{ checkedAt: string; results: Result[] } | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [failed, setFailed] = useState(false);
  const running = useRef(false);

  const runPass = useCallback(async (stored: Stored[]) => {
    if (running.current) return;
    running.current = true;
    setFailed(false);
    const targets = stored.filter((item) => item.recordedDigest);
    setProgress({ done: 0, total: targets.length });
    try {
      for (const [index, target] of targets.entries()) {
        await m1Json(workspace, "/api/digest/verify", { method: "POST", body: { objectKey: target.objectKey } });
        setProgress({ done: index + 1, total: targets.length });
      }
      const recorded = await m1Json<Check>(workspace, "/api/digest/verify", { method: "POST", body: {} });
      setCheck(recorded.checkedAt && recorded.results ? { checkedAt: recorded.checkedAt, results: recorded.results } : null);
      if (!recorded.checkedAt || !recorded.results) setFailed(true);
    } catch {
      setFailed(true);
    } finally {
      setProgress(null);
      running.current = false;
    }
  }, [workspace]);

  const load = useCallback(async () => {
    setFailed(false); setCheck(null); setObjects(null);
    try {
      const inventory = await m1Json<{ objects: Stored[] }>(workspace, "/api/digest/stored");
      setObjects(inventory.objects);
      if (inventory.objects.length === 0) return;
      const last = await m1Json<Check>(workspace, "/api/digest/verify");
      const known = new Set(inventory.objects.map((item) => item.objectKey));
      const checked = new Set((last.results ?? []).map((item) => item.objectKey));
      const covers = inventory.objects.every((item) => checked.has(item.objectKey)) && [...checked].every((key) => known.has(key));
      if (last.checkedAt && last.results && covers) {
        setCheck({ checkedAt: last.checkedAt, results: last.results });
        return;
      }
      await runPass(inventory.objects);
    } catch {
      setFailed(true);
    }
  }, [workspace, runPass]);
  useEffect(() => { void load(); }, [load]);

  const state = frame25State({ objects, check, progress, failed });
  const run = () => { if (objects && objects.length > 0 && !failed) void runPass(objects); else void load(); };
  return <M1Chrome header={header} tab="export" workspace={workspace} buildSha={buildSha} testId="m1-screen">
    <Frame25View workspace={workspace} state={state} objects={objects ?? []} onRun={run} />
  </M1Chrome>;
}
