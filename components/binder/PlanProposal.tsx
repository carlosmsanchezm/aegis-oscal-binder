"use client";
import { evidenceViewerHref } from "@/lib/builder/evidence-links";

import { createPortal } from "react-dom";
import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import {planIdentifiers} from "@/lib/aegis/plan-identifiers";
import { releaseProject } from "@/lib/aegis/control-rollup";
import { requestMessage, utcTime, receiptLabel } from "@/lib/builder/presentation";
import { freshnessLabel } from "@/lib/builder/evidence";
import { CCM_EXAMPLE, type PipelineEvidence } from "@/lib/aegis/pipeline-evidence";
import {
  applyDecision, importProposalDecisions,
  decisionFromProposal,
  normalizePlanDecision,
  plainPlan, proposalStatus,
  proposePlans,
  type PlanDecision,
  type PlanProposal,
} from "@/lib/aegis/plan-proposal";
import { SA1_HEADERS } from "@/lib/aegis/sa1-demo";
import { proposalKeptInTab, saveRemediationRecord } from "@/lib/client/remediation-save";
import { useDialogFocus } from "./useDialogFocus";
import { PLAN_STEPS, type PlanStep } from "@/lib/aegis/ui-copy";

type PlanProposalApi = {
  proposals: PlanProposal[];
  addIssueDraft: (proposal: PlanProposal) => void;
  decisions: PlanDecision[];
  reset: () => Promise<void>;
  save: (decision: PlanDecision) => Promise<{ tabOnly: boolean }>;
  error: string;
  notice: string;
  loading: boolean;
  headers: Record<string, string>;
};

const PlanProposalContext = createContext<PlanProposalApi | null>(null);

export function usePlanProposals(): PlanProposalApi | null {
  return useContext(PlanProposalContext);
}

function storageKey(releases: PipelineEvidence[]): string {
  const url = releases[0]?.pipelineUrl ?? CCM_EXAMPLE.pipelineUrl;
  return `binder.plan-proposals.v1:${releaseProject(url)}`;
}

/** Tab caches follow workspace isolation; the server record key remains unchanged. */
export function proposalTabStorageKey(recordKey: string, planning: boolean): string {
  return `${recordKey}:${planning ? "planning" : "standard"}`;
}

function readDecisions(value: unknown): PlanDecision[] {
  const list = Array.isArray(value) ? value : value && typeof value === "object" && Array.isArray((value as { proposals?: unknown }).proposals) ? (value as { proposals: unknown[] }).proposals : [];
  return list.flatMap((item) => {
    const decision = normalizePlanDecision(item);
    return decision ? [decision] : [];
  });
}

export function PlanProposalProvider({ releases, children, planning = false }: { releases: PipelineEvidence[]; children: React.ReactNode; planning?: boolean }) {
  const headers = useMemo(() => planning ? SA1_HEADERS : {}, [planning]);
  const key = storageKey(releases);
  const hasReleases = releases.length > 0;
  const tabKey = proposalTabStorageKey(key, planning);
  const [decisions, setDecisions] = useState<PlanDecision[]>([]);
  const [issueDrafts,setIssueDrafts]=useState<PlanProposal[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const generation = useRef(0);
  const sessionScope = useRef("");
  const [pending, setLoading] = useState(true);
  const [loadedTabKey, setLoadedTabKey] = useState<string | null>(null);
  // Readiness belongs to this workspace, including the render before its effect runs.
  const loading = pending || !hasReleases || loadedTabKey !== tabKey;
  const computed = useMemo(() => [...new Map([...proposePlans(releases),...issueDrafts].map(p=>[p.id,p])).values()], [releases,issueDrafts]);
  const proposals = useMemo(
    () => computed.map((proposal) => applyDecision(proposal, decisions.find((decision) => decision.id === proposal.id) ?? null)),
    [computed, decisions],
  );
  useEffect(() => {
    const current = ++generation.current;
    setLoading(true);
    setLoadedTabKey(null);
    setDecisions([]);
    setIssueDrafts([]);
    setError("");
    setNotice("");
    if (!hasReleases) {
      setLoading(false);
      return;
    }
    let local: PlanDecision[] = [];
    let cachedScope="";
    sessionScope.current="";
    try {
      const raw = window.sessionStorage.getItem(tabKey);
      if (raw) {
        const cached=JSON.parse(raw) as {scope?:unknown;proposals?:unknown};
        if(typeof cached.scope === "string") {cachedScope=cached.scope;local=readDecisions(cached.proposals);}
      }
    } catch {
      if (current === generation.current) setError("Session storage is unavailable. A draft can still be accepted in this tab until reload.");
    }
    void (async () => {
      try {
        const response = await fetch(`/api/remediation?key=${encodeURIComponent(key)}`, { cache: "no-store", headers });
        if (current !== generation.current) return;
        if (!response.ok) throw new Error("Saved plan proposals could not be loaded.");
        const body = await response.json() as { record?: { proposals?: unknown; issueDrafts?: PlanProposal[] } | null; sessionScope?: string };
        setIssueDrafts((body.record?.issueDrafts??[]).filter(p=>{try{return !!normalizePlanDecision(decisionFromProposal(p));}catch{return false;}}));
        sessionScope.current=body.sessionScope ?? "";
        if(!sessionScope.current || cachedScope !== sessionScope.current) local=[];
        if (current !== generation.current) return;
        if (body.record && Array.isArray(body.record.proposals)) {
          const remote = readDecisions(body.record.proposals);
          setDecisions(remote);
          try { window.sessionStorage.setItem(tabKey, JSON.stringify({scope:sessionScope.current,proposals:remote})); } catch { /* Server copy remains. */ }
          setError("");
          setLoadedTabKey(tabKey);
          return;
        }
        if (local.length && current === generation.current) {
          setDecisions(local);
          try {
            await persistDecisions(key, local, headers);
          } catch (cause) {
            if (!proposalKeptInTab(cause)) throw cause;
            if (current === generation.current) setNotice("Kept in this browser tab. Server session storage is unavailable.");
          }
        }
        if (current === generation.current) setLoadedTabKey(tabKey);
      } catch {
        if (current === generation.current) setError("Could not load saved plan proposals. This tab keeps any local copy.");
      } finally {
        if (current === generation.current) setLoading(false);
      }
    })();
  }, [key, tabKey, headers, hasReleases]);
  async function save(decision: PlanDecision): Promise<{ tabOnly: boolean }> {
    const normalized = normalizePlanDecision(decision);
    if (!normalized) throw new Error("The draft is not valid.");
    const version = generation.current;
    const scopedHeaders=sessionScope.current ? {...headers,"x-aegis-expected-session":sessionScope.current} : headers;
    try {
      const record = await saveRemediationRecord({ key, assessment: null, assessments: {}, plans: [], proposals: [normalized] }, { proposalIds: [normalized.id], planIds: [], assessmentKeys: [] }, scopedHeaders, scope=>{if(version === generation.current)sessionScope.current=scope;});
      const next = readDecisions(record.proposals);
      if (version !== generation.current) return { tabOnly: false };
      setDecisions(next);
      try { window.sessionStorage.setItem(tabKey, JSON.stringify({scope:sessionScope.current,proposals:next})); } catch { /* Server copy remains. */ }
      setError("");
      setNotice("");
      return { tabOnly: false };
    } catch (cause) {
      if (!proposalKeptInTab(cause) || version !== generation.current) throw cause;
      const next = [...decisions.filter((item) => item.id !== normalized.id), normalized];
      try {
        window.sessionStorage.setItem(tabKey, JSON.stringify({scope:sessionScope.current,proposals:next}));
      } catch {
        throw new Error("Could not save the draft in this browser tab.", { cause });
      }
      if (version !== generation.current) return { tabOnly: true };
      setDecisions(next);
      setError("");
      setNotice("Kept in this browser tab. Server session storage is unavailable.");
      return { tabOnly: true };
    }
  }
  async function reset() {
    const current=++generation.current;setLoading(true);setError("");
    const scopedHeaders=sessionScope.current ? {...headers,"x-aegis-expected-session":sessionScope.current} : headers;
    try {
      const response=await fetch(`/api/remediation?key=${encodeURIComponent(key)}`,{method:"DELETE",headers:scopedHeaders});
      if(!response.ok)throw new Error("Could not reset this workspace's review decisions.");
      if(current!==generation.current)return;
      try {sessionStorage.removeItem(tabKey);} catch {}
      setDecisions([]);setNotice("Review decisions reset for this workspace. Retained evidence is unchanged.");
    } catch(cause) {setError(requestMessage(cause,"Review reset failed."));}
    finally {if(current===generation.current)setLoading(false);}
  }
  return <PlanProposalContext.Provider value={{ addIssueDraft: proposal=>setIssueDrafts(current=>[...current.filter(p=>p.id!==proposal.id),proposal]), proposals, decisions, save, reset, error, notice, loading, headers }}>{children}</PlanProposalContext.Provider>;
}

export function ResetPlanReview() {
  const ctx=usePlanProposals();
  const [importError, setImportError] = useState("");
  async function importFile(file?: File) {
    if (!file || !ctx) return;
    try {
      if(file.size > 512000) throw new Error("Use a plan file smaller than 500 KB.");
      const decisions = importProposalDecisions(JSON.parse(await file.text()));
      if (!decisions.length) throw new Error("No readable internal plan record in this OSCAL file.");
      for (const decision of decisions) {
        if(!ctx.proposals.some(p=>p.id===decision.id && p.finding===decision.finding)) throw new Error("This plan belongs to a different finding or system.");
        await ctx.save(decision);
      }
      setImportError("");
    } catch(cause) {setImportError(requestMessage(cause, "Could not import the plan."));}
  }
  return ctx ? <><label className="pipeline-import">Import OSCAL plan JSON<input type="file" accept=".json,application/json" disabled={ctx.loading} onChange={e=>{void importFile(e.currentTarget.files?.[0]);e.currentTarget.value="";}} /></label>{importError && <p role="alert">{importError}</p>}{ctx.decisions.length>0 && <button type="button" className="text-btn review-reset" disabled={ctx.loading || !ctx.decisions.length} onClick={()=>void ctx.reset()} title="Clears accepted drafts and review decisions for this workspace in your planning session. Retained observations and the SSP stay as they are.">Reset workspace review decisions</button>}{ctx.notice && <p role="status" className="hint">{ctx.notice}</p>}{ctx.error && <p role="alert" className="hint">{ctx.error}</p>}</> : null;
}

async function persistDecisions(key: string, proposals: PlanDecision[], headers: Record<string, string>) {
  await saveRemediationRecord({ key, assessment: null, assessments: {}, plans: [], proposals }, undefined, headers);
}

export function resolvedProposal(controlId: string, finding: string, history: PipelineEvidence[] | undefined, decisions: PlanDecision[]): PlanProposal | null {
  if (!finding.trim() || !history?.length) return null;
  const raw = proposePlans(history).find((proposal) => proposal.controlId === controlId && proposal.finding === finding);
  if (!raw) return null;
  return applyDecision(raw, decisions.find((decision) => decision.id === raw.id) ?? null);
}

/** The plan of action for one finding: saved decisions first, else the recorded proposal. */
export function useResolvedProposal(controlId: string, finding: string, history?: PipelineEvidence[]): PlanProposal | null {
  const ctx = usePlanProposals();
  return ctx?.proposals.find(p=>p.controlId === controlId && p.finding === finding) ?? resolvedProposal(controlId, finding, history, ctx?.decisions ?? []);
}

export function ProposedPlanSummary({
  controlId,
  finding,
  history,
  primary = false,
}: {
  controlId: string;
  finding: string;
  history?: PipelineEvidence[];
  primary?: boolean;
}) {
  const ctx = usePlanProposals();
  const [open, setOpen] = useState(false);
  const proposal = useResolvedProposal(controlId, finding, history);
  if (!proposal) return null;
  const loading = ctx?.loading ?? true;
  return (
    <>
      <section className="panel-block" data-testid="proposed-plan-summary">
        <div className="label-row">
          <span className="kicker">Plan of action</span>
        </div>
        <p className="pipeline-control-finding">{proposal.controlId} · {proposal.findingTitle}</p><p className="hint" title="Current plan status uses all retained observations for this finding. The evidence panel follows the selected snapshot.">{loading ? "Loading saved plan decisions…" : proposalStatus(proposal)}</p>
        {proposal.retests.length > 0 && <p className="hint">
          {`Retest attached${proposal.correctiveReleaseId ? ` from #${receiptLabel(proposal.correctiveReleaseId)}` : ""}. ${proposal.retests.map(r=>`${r.reportedVerdict ? "Captured "+r.reportedVerdict.toUpperCase() : "recorded"} · ${freshnessLabel(r.evidenceState??"unknown")}`).join(", ")}`}
        </p>}
        <button type="button" className={primary ? "text-btn side-primary" : "text-btn"} disabled={loading} onClick={() => setOpen(true)}>{loading ? "Loading saved plan…" : "Open plan of action"}</button>
      </section>
      {open && <PlanProposalDrawer proposal={proposal} onClose={() => setOpen(false)} />}
    </>
  );
}

function Field({
  label,
  value,
  onChange,
  multiline = false,
  wrap = false,
  type = "text",
  hint, accessibleLabel,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  multiline?: boolean;
  /** Single-line value that wraps on screen instead of truncating. */
  wrap?: boolean;
  type?: string;
  hint?: string;
  accessibleLabel?: string;
}) {
  return (
    <label className="rem-field">
      <span>{label}</span>
      {multiline ? (
        <textarea aria-label={accessibleLabel ?? label} rows={3} value={value} onChange={(event) => onChange(event.target.value)} maxLength={12000} />
      ) : wrap ? (
        <textarea className="rem-field-wrap" aria-label={accessibleLabel ?? label} rows={2} value={value} onKeyDown={(event) => { if (event.key === "Enter") event.preventDefault(); }} onChange={(event) => onChange(event.target.value.replace(/[\r\n]+/g, " "))} maxLength={12000} />
      ) : (
        <input aria-label={accessibleLabel ?? label} type={type} value={value} onChange={(event) => onChange(event.target.value)} maxLength={type === "date" ? 10 : 12000} />
      )}
      {hint && <small>{hint}</small>}
    </label>
  );
}

export function PlanProposalDrawer({ proposal, onClose }: { proposal: PlanProposal; onClose: () => void }) {
  const ctx = usePlanProposals();
  const ref = useDialogFocus(onClose);
  const [risk, setRisk] = useState(proposal.riskStatement);
  const [action, setAction] = useState(proposal.action);
  const [milestone, setMilestone] = useState(proposal.milestone.description);
  const [target, setTarget] = useState(proposal.milestone.target);
  const [identifiers, setIdentifiers] = useState<{finding: string; observation: string; risk: string} | null>(null);
  useEffect(()=>{let current=true;void planIdentifiers(proposal).then(ids=>{if(current)setIdentifiers(ids);}).catch(()=>{if(current)setIdentifiers(null);});return ()=>{current=false;};},[proposal.id]);
  const [owner, setOwner] = useState(plainPlan(proposal).whoOwnsIt);
  const [closer, setCloser] = useState(proposal.closure?.name ?? "");
  const [reason, setReason] = useState(proposal.closure?.reason ?? "");
  const [officialId, setOfficialId] = useState(proposal.officialId);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [edited, setEdited] = useState(false);
  useEffect(() => {
    setRisk(proposal.riskStatement);
    setAction(proposal.action);
    setMilestone(proposal.milestone.description);
    setTarget(proposal.milestone.target);
    setOfficialId(proposal.officialId);
    setEdited(false);
  }, [proposal.id, proposal.finding]);
  const draft = decisionFromProposal(proposal, {
    riskStatement: risk,
    action,
    milestone: { description: milestone, target },
    officialId, owner,
    acceptance: proposal.acceptance,
    closureConfirmed: proposal.closureConfirmed,
  });
  async function store(next: PlanDecision): Promise<{ tabOnly: boolean }> {
    if (!ctx) throw new Error("Could not store the draft for this session.");
    setBusy(true);
    setError("");
    try {
      return await ctx.save(next);
    } catch (cause) {
      setError(requestMessage(cause,"Could not store the draft for this session."));
      throw cause;
    } finally {
      setBusy(false);
    }
  }
  async function accept() {
    await store(decisionFromProposal(proposal, {
      riskStatement: risk,
      action,
      milestone: { description: milestone, target },
      officialId, owner,
      acceptance: "accepted",
      closureConfirmed: false,
    }));
    setEditing(false);
  }
  async function confirmClosure() {
    if (!closer.trim() || !reason.trim()) {setError("Enter your name and a reason to confirm closure."); return;}
    if (!proposal.readyToClose || proposal.acceptance !== "accepted") {setError("Accept the plan and attach a qualifying passing retest first."); return;}
    await store(decisionFromProposal(proposal, {
      riskStatement: risk,
      action,
      milestone: { description: milestone, target },
      officialId, owner,
      acceptance: "accepted",
      closureConfirmed: true,
      closure: {name: closer.trim(), reason: reason.trim(), at: new Date().toISOString()},
    }));
  }
  async function download() {
    const accepted = decisionFromProposal(proposal, {
      riskStatement: risk,
      action,
      milestone: { description: milestone, target },
      officialId, owner,
      acceptance: "accepted",
      closureConfirmed: proposal.closureConfirmed,
    });
    const stored = await store(accepted);
    const proposalUrl = `/api/remediation/oscal?proposal=${encodeURIComponent(proposal.id)}`;
    let response = await fetch(proposalUrl, { cache: "no-store", headers: ctx?.headers });
    if (!response.ok && stored.tabOnly) {
      response = await fetch(proposalUrl, {
        method: "POST",
        cache: "no-store",
        headers: { ...ctx?.headers, "content-type": "application/json" },
        body: JSON.stringify({ decision: accepted }),
      });
    }
    if (!response.ok) throw new Error("The plan of action file could not be downloaded.");
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "plan-of-action-and-milestones.json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const canAccept = Boolean(risk.trim() && action.trim() && milestone.trim());
  const saving = busy || ctx?.loading === true;
  const changed = risk !== proposal.riskStatement || action !== proposal.action || milestone !== proposal.milestone.description || target !== proposal.milestone.target;
  const step: PlanStep = proposal.closureConfirmed || (proposal.acceptance === "accepted" && proposal.readyToClose) ? "Close"
    : proposal.acceptance === "accepted" ? "Retest"
    : editing ? "Edit"
    : edited || changed ? "Accept" : "Review";
  const stepIndex = PLAN_STEPS.indexOf(step);
  // The header and the Status field read one status line so they never disagree.
  const statusLine = ctx?.decisions.some(d=>d.id === proposal.id && d.finding !== proposal.finding) ? "Finding description changed" : proposalStatus(proposal);
  return createPortal(
    <div className="rem-overlay">
      <section ref={ref} tabIndex={-1} className="rem-drawer rem-draft-drawer poam-view proposal-drawer" role="dialog" aria-modal="true" aria-labelledby="proposal-title" data-testid="plan-proposal">
        <header>
          <h2 id="proposal-title">Plan of action <span className="pill">{proposal.controlId}</span></h2>
          <span data-testid="plan-header-status">{statusLine}</span>
          <button type="button" className="text-btn plan-download" disabled={saving || proposal.acceptance !== "accepted"} onClick={() => void download().catch((cause: unknown) => setError(requestMessage(cause,"The plan of action file could not be downloaded.")))}>Download OSCAL plan of action</button>
          <button type="button" onClick={onClose} aria-label="Close proposed plan">×</button>
        </header>
        <ol className="plan-stepper" aria-label="Plan progress">{PLAN_STEPS.map((label, index) => {
          const state = index < stepIndex || proposal.closureConfirmed ? "done" : index === stepIndex ? "current" : "later";
          return <li key={label} data-state={state} aria-current={state === "current" ? "step" : undefined}><span>{state === "done" ? "✓" : index + 1}</span>{label}</li>;
        })}</ol>
        <div className="rem-drawer-body">
<section className="proposal-section"><h3>Status</h3>{proposal.pullRequest && <p><a href={proposal.pullRequest.prUrl} target="_blank" rel="noreferrer">PR #{proposal.pullRequest.prNumber}</a>{" "}<span className="pill" aria-label={`CI ${proposal.pullRequest.ciStatus.state}`}>CI {proposal.pullRequest.ciStatus.state}</span></p>}<p data-testid="plain-plan-status">{statusLine}</p><h3>What is wrong</h3><p>{proposal.finding}</p><div className="release-section-title"><h3>Plan</h3><button type="button" className={step === "Review" || step === "Edit" ? "btn primary" : "text-btn"} onClick={() => { if (editing) setEdited(true); setEditing((value) => !value); }}>{editing ? "Done editing" : "Edit plan"}</button></div><div className={`proposal-fields${editing ? " is-editing" : ""}`}><Field label="Why it matters" accessibleLabel="Risk statement" value={risk} onChange={setRisk} multiline hint="Agency risk acceptance is not recorded." />
          <Field label="What we will do" accessibleLabel="Corrective action" value={action} onChange={setAction} multiline hint={proposal.closureConfirmed ? "You confirmed closure of this internal plan; agency acceptance is not recorded." : proposal.acceptance === "accepted" ? "Closure needs your confirmation." : undefined} />
          <Field label="Who owns it" value={owner} onChange={value=>setOwner(value.slice(0,200))} /><div className="proposal-milestone"><Field label="Done when" accessibleLabel="Proposed milestone" value={milestone} onChange={setMilestone} wrap />
          <Field label="Due by" accessibleLabel="Milestone target" type="date" value={target} onChange={setTarget} hint={target ? "Review or change this target date." : "No target date set."} /></div></div></section><section className={`proposal-section proposal-proof${proposal.acceptance === "accepted" && proposal.retests.some(r=>r.evidenceState === "stale") && !proposal.readyToClose ? " is-highlight" : ""}`}>
          <details>
          <summary>{proposal.retests.some(r => r.reportedVerdict) ? "Retest observations" : proposal.readyToClose || proposal.closureConfirmed ? "Passing retest measurements" : "Retest needed to prove the fix"}</summary>
          <ol className="poam-list">
            {proposal.provingChecks.map((check) => {
              const retest = proposal.retests.find((item) => item.description === check);
              return (
                <li key={check}>
                  <strong>{check}</strong>
                  <p>{retest?.result.trim() || "No result recorded."}</p>
                  <small>{retest ? `${retest.reportedVerdict ? `Captured ${retest.reportedVerdict.toUpperCase()}` : retest.verdict ? retest.verdict.toUpperCase() : "Recorded"} · ${retest.capturedAt ? utcTime(retest.capturedAt,true) : retest.date || "no date"} · #${retest.releaseId}` : "Not attached"}</small>
                  {retest?.evidenceState && <p>Evidence freshness: {freshnessLabel(retest.evidenceState)} · valid until {retest.validUntil ? utcTime(retest.validUntil) : "not recorded"}{retest.evidenceState === "stale" && " · collect a fresh retest before closure"}</p>}
                  {retest?.evidence ? <a href={evidenceViewerHref(retest.evidence)} target="_blank" rel="noopener noreferrer">Retest evidence ↗</a> : <span>No retest evidence linked.</span>}
                </li>
              );
            })}
          </ol>
          {proposal.retests.some(r=>r.evidenceState === "stale") && !proposal.readyToClose && <div className="proposal-retest-warning"><strong>Collect a fresh retest before closure.</strong><p>The captured PASS stays recorded. Freshness uses the original capture and valid-until timestamps; loading a historical example does not renew its validity.</p><a className={step === "Retest" ? "btn primary" : "text-btn"} href="/planning?view=connections">Collect fresh retest →</a></div>}
          </details>
          </section><details className="proposal-section proposal-official"><summary>More</summary><Field label="Official plan id" value={officialId} onChange={(value) => setOfficialId(value.slice(0, 200))} hint="Blank until you record one." />

          </details><section className="proposal-section"><h3>A person confirms closure</h3><Field label="Closure name" value={closer} onChange={value=>setCloser(value.slice(0,200))} /><Field label="Closure reason" value={reason} onChange={setReason} multiline />{proposal.closureConfirmed && <p>Closed {proposal.closure?.at} by {proposal.closure?.name} · {proposal.closure?.reason}</p>}</section>          <details className="proposal-section"><summary>Rev5 and OSCAL details</summary><h3>Finding</h3>
          {ctx?.decisions.some(d => d.id === proposal.id && d.finding !== proposal.finding) && <p role="status">The finding description changed. Review and accept the corrected draft; the earlier acceptance does not apply.</p>}
          <dl className="poam-facts">
            <dt>NIST SP 800-53 Rev5 control</dt>
            <dd>{proposal.controlId}</dd>
            <dt>Finding</dt>
            <dd>{proposal.finding}</dd>
            <dt>Source</dt>
            <dd><a href={evidenceViewerHref(proposal.result?.sourceReleaseUrl)} target="_blank" rel="noreferrer">Original failed observation #{receiptLabel(proposal.sourceReleaseId)}</a>{proposal.correctiveReleaseId && <> · <a href={evidenceViewerHref(proposal.result?.correctiveReleaseUrl)} target="_blank" rel="noreferrer">Retest #{receiptLabel(proposal.correctiveReleaseId)}</a></>}</dd>
            <dt>Source finding UUID</dt><dd>{identifiers?.finding ?? "Loading OSCAL identifier…"}</dd>
            <dt>Source observation UUID</dt><dd>{identifiers?.observation ?? "Loading OSCAL identifier…"}</dd>
            <dt>Risk rating</dt><dd>Not rated by the retained evidence</dd>
            <dt>Remediation</dt><dd>{action}</dd>
            <dt>Milestones</dt><dd>{milestone} · {target || "No due date"}</dd>
            <dt>Point of contact</dt><dd>{owner || "Unassigned"}</dd>
            <dt>Detection date</dt><dd>{proposal.result?.sourceCreatedAt ?? "Not recorded"}</dd>
            <dt>Completion date</dt><dd>{proposal.closureConfirmed ? proposal.closure?.at : "Open"}</dd>
            <dt>Related observations</dt><dd>{identifiers?.observation}</dd>
            <dt>Related risks</dt><dd>{identifiers?.risk}</dd>
          </dl>
          {proposal.result?.sourceArtifacts.length ? <details><summary>Original finding evidence</summary><ul>{proposal.result.sourceArtifacts.map(artifact => <li key={artifact.href}><a href={evidenceViewerHref(artifact.href)} target="_blank" rel="noreferrer">{artifact.name}</a></li>)}</ul></details> : null}
          </details>{(error || ctx?.error) && <p role="alert" className="pipeline-error">{error || ctx?.error}</p>}
          {ctx?.notice && <p className="hint">{ctx.notice}</p>}
        </div>
        <footer>
          {proposal.acceptance !== "accepted" && (
            <button type="button" className={step === "Accept" ? "btn primary" : "btn ghost"} disabled={saving || !canAccept} onClick={() => void accept().catch(() => undefined)}>Accept proposed draft</button>
          )}
          {proposal.acceptance === "accepted" && editing && (
            <button type="button" className="text-btn" disabled={saving || !canAccept} onClick={() => void store(draft).catch(() => undefined)}>Save edits</button>
          )}
          <button type="button" className={step === "Close" && !proposal.closureConfirmed ? "btn primary" : "btn ghost"} title={proposal.acceptance === "accepted" && !proposal.readyToClose ? "Collect a fresh retest before closure." : undefined} disabled={saving || proposal.acceptance !== "accepted" || !proposal.readyToClose || proposal.closureConfirmed} onClick={() => void confirmClosure().catch(() => undefined)}>Confirm closure</button>
          <small>{proposal.acceptance === "accepted" ? (proposal.closureConfirmed ? "Closed by you. The exported risk is closed for this internal plan; agency acceptance is not recorded." : "Accepted substance can be exported. Closure stays unconfirmed until you confirm it.") : "A proposed draft is not exported and does not claim closure."}</small>
        </footer>
      </section>
    </div>, document.body
  );
}
