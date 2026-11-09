"use client";
import { requestMessage } from "@/lib/builder/presentation";
import React, { useEffect, useRef, useState } from "react";
import type { PipelineEvidence } from "@/lib/aegis/pipeline-evidence";
import { gitlabArtifactUrl, pipelineArtifactNames } from "@/lib/aegis/pipeline-evidence";
import { blankReviewScope, NETWORK_POLICY_EXAMPLE_SCOPE, scopeProblems } from "@/lib/aegis/review-context";
import {
  addHistory,
  applyRetestPacket,
  applyReceivedVerification,
  planScope,
  remainingScope,
  assessmentProblems,
  closureProblems,
  confirmed,
  emptyAssessment,
  engineeringProblems,
  exportDraft,
  illustrativeAssessment,
  illustrativeScopedAssessment,
  illustrativeProgress,
  milestoneProblems,
  newPlan,
  readinessProblems,
  restorePlan,
  restoreAssessment,
  revisePlan,
  resetReviewDecisions,
  updatePlanAssessment,
  latestReviewPlan,
  safeReferenceUrl,
  validationProblems,
  type Assessment,
  type RemediationPlan,
} from "@/lib/aegis/remediation";
import { AssessmentResultsView } from "./AssessmentResults";
import { saveRemediationRecord } from "@/lib/client/remediation-save";
import { resolveDraftDecisions } from "@/lib/aegis/remediation-rollup";
import { mergeStoredReleases } from "@/lib/aegis/control-rollup";
import { PlanOfActionView } from "./PlanOfAction";
import { useDialogFocus } from "./useDialogFocus";
import { PLAN_STEPS, type PlanStep } from "@/lib/aegis/ui-copy";

export function useRemediation(record: PipelineEvidence) {
  const [assessment, setAssessment] = useState<Assessment>(emptyAssessment);
  const [assessments, setAssessments] = useState<Record<string,Assessment>>({});
  const [plans, setPlans] = useState<RemediationPlan[]>([]);
  const [storageError, setStorageError] = useState("");
  const [loading, setLoading] = useState(true);
  const key = `binder.remediation.v1:${record.pipelineUrl}:${record.commitSha}`;
  const saveGeneration = useRef(0);
  const sessionScope=useRef("");
  const scopedHeaders=(): Record<string,string> => sessionScope.current ? {"x-aegis-expected-session":sessionScope.current} : {};
  function decode(stored: { plans?: unknown; assessment?: Assessment; assessments?: Record<string, unknown> }) {
    const restored = Array.isArray(stored.plans)
      ? (stored.plans.map((p: unknown) => restorePlan(p, record)).filter(Boolean) as RemediationPlan[])
      : [];
    const byItem: Record<string, Assessment> = {};
    for (const [item, value] of Object.entries(stored.assessments ?? {})) {
      const restoredAssessment = restoreAssessment(value);
      if (restoredAssessment && [...(record.reviewItems ?? []).map((x) => x.description), ...record.gaps].includes(item)) byItem[item] = restoredAssessment;
    }
    let nextAssessment = emptyAssessment();
    const savedAssessment = stored.assessment;
    if (savedAssessment && !savedAssessment.scope && savedAssessment.illustrative) savedAssessment.scope = structuredClone(NETWORK_POLICY_EXAMPLE_SCOPE);
    if (
      savedAssessment &&
      [savedAssessment.note, savedAssessment.requirement, savedAssessment.reference, savedAssessment.reviewer, savedAssessment.date].every((s) => typeof s === "string") &&
      typeof savedAssessment.illustrative === "boolean" &&
      ["needs-verification", "confirmed", "no-deficiency"].includes(savedAssessment.disposition) &&
      !assessmentProblems(savedAssessment).length
    ) {
      nextAssessment = savedAssessment;
      const item = record.gaps.find((g) => /network.policy/i.test(g));
      if (item && !byItem[item]) byItem[item] = savedAssessment;
    }
    return { restored, byItem, nextAssessment, dropped: Array.isArray(stored.plans) && stored.plans.length !== restored.length };
  }
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const generation = saveGeneration.current;
    sessionScope.current="";
    setLoading(true);
    setAssessment(emptyAssessment());
    setAssessments({});
    setPlans([]);
    setStorageError("");
    let local: ReturnType<typeof decode> | null = null;
    try {
      const raw = window.sessionStorage.getItem(key);
      if (raw) {
        if (raw.length > 1_000_000) throw new Error("Record exceeds the session limit.");
        local = decode(JSON.parse(raw));
        setPlans(local.restored);
        setAssessment(local.nextAssessment);
        setAssessments(local.byItem);
        if (local.dropped) setStorageError("Some stored drafts could not be reopened. Use your exported copy; invalid records were not loaded.");
      }
    } catch {
      setStorageError("Session storage is unavailable or invalid. Changes work in memory; export a copy before leaving.");
    }
    void (async () => {
      try {
        const response = await fetch(`/api/remediation?key=${encodeURIComponent(key)}`, { cache: "no-store", signal:controller.signal });
        if (cancelled || generation !== saveGeneration.current) return;
        if (!response.ok) throw new Error("Saved records could not be loaded.");
        const body = await response.json() as { sessionScope?:string; record?: { plans?: unknown; assessment?: Assessment; assessments?: Record<string, unknown> } | null };
        if (cancelled || generation !== saveGeneration.current) return;
        sessionScope.current=body.sessionScope ?? "";
        if (body.record && Array.isArray(body.record.plans)) {
          const remote = decode(body.record);
          setPlans(remote.restored);
          setAssessment(remote.nextAssessment);
          setAssessments(remote.byItem);
          try {
            window.sessionStorage.setItem(key, JSON.stringify({ assessment: remote.nextAssessment, assessments: remote.byItem, plans: remote.restored }));
          } catch { /* The server copy remains the saved draft. */ }
          setStorageError(remote.dropped ? "Some stored drafts could not be reopened. Use your exported copy; invalid records were not loaded." : "");
          return;
        }
        if (local && (local.restored.length || Object.keys(local.byItem).length) && generation === saveGeneration.current) {
          await saveRemediationRecord({ key, assessment: local.nextAssessment, assessments: local.byItem, plans: local.restored },undefined,scopedHeaders());
        }
      } catch {
        if (!cancelled) setStorageError("Could not load saved records from the server. This tab retains any local copy; retry loading before editing.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; controller.abort(); };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  function persist(a: Assessment, ps: RemediationPlan[], byItem = assessments, changes?: Parameters<typeof saveRemediationRecord>[1]) {
    saveGeneration.current += 1;
    try {
      window.sessionStorage.setItem(key, JSON.stringify({ assessment: a, assessments: byItem, plans: ps }));
    } catch {
      setStorageError("Could not save in this browser tab.");
    }
    return saveRemediationRecord({ key, assessment: a, assessments: byItem, plans: ps }, changes,scopedHeaders()).then(() => {
      setStorageError("");
    }).catch((cause: unknown) => {
      setStorageError("Could not store changes on the server. This tab retains a local copy; retry saving before leaving.");
      throw cause;
    });
  }
  return {
    assessment,
    assessmentFor(item:string) {return Object.hasOwn(assessments,item)?assessments[item]:emptyAssessment();},
    plans,
    storageError,
    loading,
    saveAssessment(a: Assessment,item:string) {
      if (assessmentProblems(a).length)
        throw new Error(assessmentProblems(a).join(" "));
      setAssessment(a);
      const next={...assessments,[item]:a};setAssessments(next);
      const current = latestReviewPlan(plans, record, item);
      const updated = plans.map(p => p.id === current?.id ? updatePlanAssessment(p, a, new Date().toISOString()) : p);
      setPlans(updated);
      return persist(a, updated,next, { assessment: true, assessmentKeys: [item], planIds: current ? [current.id] : [], proposalIds: [] });
    },
    savePlan(p: RemediationPlan) {
      const next = [...plans.filter((item) => item.id !== p.id), p];
      setPlans(next);
      return persist(assessment, next, assessments, { planIds: [p.id], proposalIds: [], assessmentKeys: [] });
    },
  };
}
function Field({
  label,
  value,
  onChange,
  multiline = false,
  type = "text",
  hint,
  readOnly = false,
  caption,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  multiline?: boolean;
  type?: string;
  hint?: string;
  readOnly?: boolean;
  caption?: string;
}) {
  return (
    <label className="rem-field">
      <span>{caption ?? label}</span>
      {multiline ? (
        <textarea
          aria-label={label}
          rows={3}
          value={value}
          readOnly={readOnly}
          onChange={(e) => onChange(e.target.value)}
          maxLength={12000}
        />
      ) : (
        <input
          aria-label={label}
          type={type}
          value={value}
          readOnly={readOnly}
          onChange={(e) => onChange(e.target.value)}
          maxLength={12000}
        />
      )}
      {hint && <small>{hint}</small>}
    </label>
  );
}
function Issues({ problems }: { problems: string[] }) {
  return problems.length ? (
    <ul className="rem-issues">
      {problems.map((p) => (
        <li key={p}>{p}</li>
      ))}
    </ul>
  ) : null;
}
function Reference({
  value,
  fallback = "Not linked",
}: {
  value: string;
  fallback?: string;
}) {
  const fixtures: Record<string, string> = {
    "ILLUSTRATIVE networkpolicy.json":
      "/samples/remediation/networkpolicy.json",
    "ILLUSTRATIVE denied-traffic.log":
      "/samples/remediation/denied-traffic.log",
    "ILLUSTRATIVE gateway-path.log": "/samples/remediation/gateway-path.log",
  };
  const url = fixtures[value] ?? safeReferenceUrl(value);
  const linkLabel = url ? (fixtures[value] ? value.replace(/^ILLUSTRATIVE /, "") : new URL(url).pathname.includes("/-/pipelines/") ? `Pipeline #${new URL(url).pathname.split("/").at(-1)}` : new URL(url).pathname.split("/").filter(Boolean).at(-1) || new URL(url).hostname) : value;
  return url ? (
    <a href={url} title={value} target="_blank" rel="noopener noreferrer">
      {linkLabel} ↗
    </a>
  ) : (
    <span>{value || fallback}</span>
  );
}
function Sources({ record, names }: { record: PipelineEvidence; names:string[] }) {
  return (
    <div className="rem-evidence">
      {names.map((name) => {
        const url = gitlabArtifactUrl(record, name);
        return (
          <div key={name}>
            <strong>{name}</strong>
            <small>Recorded · #{record.pipelineId}</small>
            {url ? (
              <a href={url} target="_blank" rel="noopener noreferrer">
                Source artifact ↗
              </a>
            ) : (
              <span>No source link supplied</span>
            )}
          </div>
        );
      })}
    </div>
  );
}
export function AssessmentDrawer({
  record,
  reviewItem,
  initial,
  onSave,
  onPrepare,
  onOpenSavedDraft,
  onClose,
}: {
  record: PipelineEvidence;
  reviewItem: string;
  initial: Assessment;
  onSave: (a: Assessment) => void | Promise<void>;
  onPrepare: (a: Assessment) => void;
  onOpenSavedDraft?: () => void;
  onClose: () => void;
}) {
  const [a, setA] = useState(initial);
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const ref = useDialogFocus(onClose);
  const change = (patch: Partial<Assessment>) => {
    setA({ ...a, ...patch });
    setMessage("");
  };
  const problems = assessmentProblems(a);
  const scope=a.scope??blankReviewScope();
  const setScope=(patch:Partial<typeof scope>)=>change({scope:{...scope,...patch}});
  async function saveAssessment(prepare = false) {
    setSaving(true);
    setMessage("");
    try {
      await onSave(a);
      if (prepare) onPrepare(a);
      else setMessage("Assessment saved for this session.");
    } catch {
      setMessage("Assessment was not saved on the server. Retry before leaving.");
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="rem-overlay">
      <section
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="assessment-title"
        className="rem-drawer"
        data-testid="assessment-drawer"
      >
        <header>
          <span>Review item · ISSE assessment</span>
          <button type="button" onClick={onClose} aria-label="Close assessment">
            ×
          </button>
        </header>
        <div className="rem-drawer-body">
          <h2 id="assessment-title">
            {scope.title || "Assess review observation"}
          </h2>
          <details><summary>Original review observation</summary><p>{reviewItem}</p></details>
          <div className="rem-chips">
            {scope.controls.map(id=><b key={id}>{id}</b>)}
          </div>
          <h3>
            Linked release evidence <small>recorded</small>
          </h3>
          <Sources record={record} names={scope.artifacts} />
          <details className="rem-scope-editor" open={!scope.title || !scope.controls.length}>
            <summary>System, policy & verification scope</summary>
            <div className="rem-two"><Field label="Finding title" value={scope.title} onChange={title=>setScope({title})}/><Field label="Assessment asset" value={scope.asset} onChange={asset=>setScope({asset})}/><Field label="Framework reference" value={scope.framework} onChange={framework=>setScope({framework})}/><Field label="Policy or baseline reference" value={scope.baseline} onChange={baseline=>setScope({baseline})}/></div>
            <Field label="Control references" value={scope.controls.join(", ")} onChange={value=>setScope({controls:value.split(",").map(v=>v.trim()).filter(Boolean)})} hint="Comma-separated IDs. Mapping is reviewer-selected, not a compliance determination."/>
            <fieldset className="rem-options"><legend>Source artifacts</legend>{pipelineArtifactNames(record).map(name=><label key={name}><input type="checkbox" checked={scope.artifacts.includes(name)} onChange={e=>setScope({artifacts:e.target.checked?[...scope.artifacts,name]:scope.artifacts.filter(v=>v!==name)})}/>{name}</label>)}</fieldset>
            <Field label="Required verification tests" value={scope.verification.join("\n")} multiline onChange={value=>setScope({verification:value.split("\n")})} hint="One test per line. Results must be recorded separately."/>
            <Field label="Outside this assessment" value={scope.remainingScope.join("\n")} multiline onChange={value=>setScope({remainingScope:value.split("\n").filter(Boolean)})}/>
          </details>
          <p className="rem-muted">
            {scope.framework || "Framework not selected"} · {scope.baseline || "Policy not selected"} · control-level context only
          </p>
          <fieldset className="rem-options">
            <legend>Disposition · scoped assessment only</legend>
            {[
              ["needs-verification", "Needs verification"],
              ["confirmed", "Confirmed deficiency"],
              ["no-deficiency", "No deficiency identified"],
            ].map(([value, label]) => (
              <label key={value}>
                <input
                  type="radio"
                  name="assessment-disposition"
                  checked={a.disposition === value}
                  onChange={() =>
                    change({ disposition: value as Assessment["disposition"] })
                  }
                />
                <span>{label}</span>
              </label>
            ))}
          </fieldset>
          <h3>Assessment record</h3>
          <Field
            label="Applicable requirement"
            value={a.requirement}
            onChange={(requirement) => change({ requirement })}
            multiline
          />
          <Field
            label="Assessment rationale"
            value={a.note}
            onChange={(note) => change({ note })}
            multiline
          />
          <Field
            label="Supporting assessment reference"
            value={a.reference}
            onChange={(reference) => change({ reference })}
          />
          <div className="rem-two">
            <Field
              label="Assessment reviewer"
              value={a.reviewer}
              onChange={(reviewer) => change({ reviewer })}
            />
            <Field
              label="Assessment date"
              type="date"
              value={a.date}
              onChange={(date) => change({ date })}
            />
          </div>
          <details className="rem-handling"><summary>Record context</summary>
          <p>Assessment decisions are entered by a reviewer, not inferred from a passing pipeline. {a.illustrative ? "This record was prepared from a sample assessment. Imported measurements remain separate." : "Agency applicability and approvals follow the designated process."}</p>
          <p>Outside this assessment: {scope.remainingScope.join(" · ") || "Not specified"}</p>
          {(!scopeProblems(scope).length || (record.pipelineId === "2894050908" && /network.policy/i.test(reviewItem))) && (
            <button
              type="button"
              className="rem-text-button"
              onClick={() => {
                setA(record.pipelineId === "2894050908" && /network.policy/i.test(reviewItem) ? illustrativeAssessment() : illustrativeScopedAssessment(scope));
                setMessage(
                  "Loaded example assessment fields. The recorded release has not been reassessed.",
                );
              }}
            >
              Load sample assessment
            </button>
          )}
          </details>
          {problems.length > 0 && <details><summary>Assessment requirements · {problems.length}</summary><Issues problems={problems} /></details>}
          <p role="status" className="rem-message">
            {message}
          </p>
        </div>
        <footer>
          <button
            className="btn ghost"
            type="button"
            disabled={saving || problems.length > 0}
            onClick={() => void saveAssessment()}
          >
            Save assessment
          </button>
          <button
            className="btn primary"
            type="button"
            disabled={saving || (!onOpenSavedDraft && !confirmed(a))}
            onClick={() => onOpenSavedDraft ? onOpenSavedDraft() : void saveAssessment(true)}
          >
            {onOpenSavedDraft ? "Open saved POA&M →" : "Prepare draft POA&M →"}
          </button>
          <small>
            {onOpenSavedDraft ? "Opens the saved draft. Unsaved assessment edits are not applied to it." : "Confirm the deficiency first. Missing evidence alone is not a deficiency."}
          </small>
        </footer>
      </section>
    </div>
  );
}
function download(p: RemediationPlan) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(exportDraft(p), null, 2)], {
      type: "application/json",
    }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = `${p.id.replace(/[^a-z0-9-]/gi, "-")}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function DraftDrawer({
  plan,
  onSave,
  onClose,
  onBack,
}: {
  plan: RemediationPlan;
  onSave: (p: RemediationPlan) => void | Promise<void>;
  onClose: () => void;
  onBack: () => void;
}) {
  const [p, setP] = useState(plan);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const ref = useDialogFocus(onClose);
  const change = (patch: Partial<RemediationPlan>) =>
    setP(revisePlan(p, patch));
  const issues = milestoneProblems(p);
  return (
    <div className="rem-overlay">
      <section
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="draft-title"
        className="rem-drawer rem-draft-drawer"
        data-testid="draft-drawer"
      >
        <header>
          <h2 id="draft-title">Draft POA&M</h2>
          <span>Draft · internal</span>
          <button type="button" onClick={onClose} aria-label="Close draft">
            ×
          </button>
        </header>
        <div className="rem-drawer-body">
          <div className="rem-trace">
            Recorded release #{p.source.pipelineId} → Scoped assessment
            → Draft POA&M
          </div>
          <h3>Finding</h3>
          <Field
            label="Weakness description"
            value={p.weakness}
            onChange={(weakness) => change({ weakness })}
            multiline
          />
          <div className="rem-two">
            <Field
              label="Affected asset"
              value={p.asset}
              onChange={(asset) => change({ asset })}
            />
            <div className="rem-field">
              <span>Control</span>
              <strong>{planScope(p).controls.join(" · ")} · reviewer-selected</strong>
              <small>No item or enhancement coverage inferred</small>
            </div>
          </div>
          <p className="rem-muted">
            Assessment record · {p.assessment.reference}
          </p>
          <div className="rem-chips">
            {p.source.artifacts.map((a) =>
              safeReferenceUrl(a.href) ? (
                <a
                  key={a.name}
                  href={a.href}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {a.name} ↗
                </a>
              ) : (
                <span key={a.name}>{a.name} · no source link</span>
              ),
            )}
          </div>
          <h3>Corrective plan</h3>
          <PlanFields p={p} change={change} />
          <h3>Milestones</h3>
          <Milestones p={p} change={change} />
          <h3>
            Record linkage <small>manual references · no sync</small>
          </h3>
          <LinkageFields p={p} change={change} />
          <Issues problems={issues} />
          {error && <p role="alert" className="pipeline-error">{error}</p>}
        </div>
        <footer>
          <button className="rem-text-button" type="button" onClick={onBack}>
            ← Back to review item
          </button>
          <div className="rem-actions">
            <button
              type="button"
              className="btn ghost"
              onClick={() => download(p)}
            >
              Export draft
            </button>
            <button
              type="button"
              className="btn primary"
              disabled={
                saving || issues.length > 0 || !p.weakness.trim() || !p.asset.trim()
              }
              onClick={async () => {
                setSaving(true);
                setError("");
                try {
                  await onSave(addHistory(p, "Draft saved; agency submission not performed.", new Date().toISOString()));
                } catch {
                  setError("Draft was not saved on the server. Retry before leaving.");
                } finally {
                  setSaving(false);
                }
              }}
            >
              Save draft
            </button>
          </div>
          <small>
            Saved with this session · OSCAL download is a separate file · not submitted
          </small>
        </footer>
      </section>
    </div>
  );
}
function PlanFields({
  p,
  change,
  owner = true,
}: {
  p: RemediationPlan;
  change: (patch: Partial<RemediationPlan>) => void;
  owner?: boolean;
}) {
  return (
    <>
      {owner && (
        <Field
          label="Responsible owner"
          value={p.owner}
          onChange={(owner) => change({ owner })}
          hint="Enter a person or accountable team; persona view is not an assignment."
        />
      )}
      <details>
        <summary>Risk rationale and required resources</summary>
        <Field
          label="Risk rationale"
          value={p.risk}
          onChange={(risk) => change({ risk })}
          multiline
        />
        <Field
          label="Required resources"
          value={p.resources}
          onChange={(resources) => change({ resources })}
          multiline
        />
      </details>
      <Field
        label="Corrective action"
        value={p.action}
        onChange={(action) => change({ action })}
        multiline
      />
      <Field
        label="Interim protection"
        value={p.protection}
        onChange={(protection) => change({ protection })}
        multiline
      />
    </>
  );
}
function LinkageFields({
  p,
  change,
}: {
  p: RemediationPlan;
  change: (patch: Partial<RemediationPlan>) => void;
}) {
  return (
    <>
      <Field
        label="Agency-designated repository"
        value={p.repository}
        onChange={(repository) => change({ repository })}
        hint="Confirm the approved location with the agency ISSO."
      />
      <Field
        label="Official POA&M ID"
        value={p.officialId}
        onChange={(officialId) => change({ officialId })}
      />
      <Field
        label="Engineering ticket"
        value={p.ticket}
        onChange={(ticket) => change({ ticket })}
      />
    </>
  );
}
function Milestones({
  p,
  change,
}: {
  p: RemediationPlan;
  change: (patch: Partial<RemediationPlan>) => void;
}) {
  return (
    <>
      <div className="rem-milestones">
        <div className="rem-milestone-columns" aria-hidden="true">
          <span>Milestone</span>
          <span>Target</span>
          <span>Revised</span>
          <span>Status</span>
        </div>
        {p.milestones.map((m, index) => {
          const update = (patch: Partial<typeof m>) =>
            change({
              milestones: p.milestones.map((item) =>
                item.id === m.id ? { ...item, ...patch } : item,
              ),
            });
          return (
            <div key={m.id} className="rem-milestone" data-status={m.status}>
              <Field
                label={`Milestone ${index + 1}`}
                value={m.description}
                onChange={(description) => update({ description })}
              />
              <div className="rem-three">
                <Field
                  label={`Target date ${index + 1}`}
                  type="date"
                  value={m.target}
                  onChange={(target) => update({ target })}
                />
                <Field
                  label={`Revised date ${index + 1}`}
                  type="date"
                  value={m.revised}
                  onChange={(revised) => update({ revised })}
                />
                <label className="rem-field">
                  <span>Status {index + 1}</span>
                  <select
                    aria-label={`Status ${index + 1}`}
                    value={m.status}
                    onChange={(e) =>
                      update({ status: e.target.value as typeof m.status })
                    }
                  >
                    {["Not started", "In progress", "Delayed", "Done"].map(
                      (s) => (
                        <option key={s}>{s}</option>
                      ),
                    )}
                  </select>
                </label>
              </div>
              {(m.status === "Delayed" || m.revised) && (
                <div className="rem-delay">
                  <span>Reason</span>
                  <Field
                    label={`Delay justification ${index + 1}`}
                    value={m.reason}
                    onChange={(reason) => update({ reason })}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>
      <button
        type="button"
        className="rem-text-button"
        disabled={p.milestones.length >= 50}
        onClick={() =>
          change({
            milestones: [
              ...p.milestones,
              {
                id: crypto.randomUUID(),
                description: "",
                target: "",
                revised: "",
                reason: "",
                status: "Not started",
              },
            ],
          })
        }
      >
        + Add milestone
      </button>
    </>
  );
}
export function RemediationWorkspace({
  saved,
  record,
  onSave,
  onBack,
  onFinding,
  onControl,
  receivedReleases = [],
}: {
  saved: RemediationPlan;
  record: PipelineEvidence;
  onSave: (p: RemediationPlan) => void | Promise<void>;
  onBack: () => void;
  onFinding: () => void;
  onControl?: () => void;
  receivedReleases?: PipelineEvidence[];
}) {
  const releases = mergeStoredReleases([...receivedReleases, record], record.pipelineUrl);
  const reviewed = resolveDraftDecisions(saved, releases);
  const needsRetestReview = saved.closure.recorded && !reviewed.closure.recorded;
  const [p, setP] = useState(reviewed);
  const [persona, setPersona] = useState<"Engineer" | "ISSE" | "ISSO">(
    "Engineer",
  );
  const [message, setMessage] = useState("");
  const [planOpen, setPlanOpen] = useState(false);
  const [resultsOpen, setResultsOpen] = useState(false);
  const mainRef = useRef<HTMLDivElement>(null);
  useEffect(() => { mainRef.current?.scrollTo({ top: 0 }); }, [persona]);
  const dirty = JSON.stringify(p) !== JSON.stringify(saved);
  const receivedCorrection = [...releases].reverse().find(r => r.verification?.sourcePipelineUrl === p.source.pipelineUrl && r.verification.sourceCommit === p.source.commit && r.verification.sourceReleaseSha256 === record.releaseSha256);
  const change = (patch: Partial<RemediationPlan>) => {
    setP(revisePlan(p, patch));
    setMessage("");
  };
  function save(action: string, patch: Partial<RemediationPlan> = {}) {
    const next = addHistory(
      { ...p, ...patch },
      action,
      new Date().toISOString(),
    );
    setP(next);
    setMessage("Saving draft…");
    void Promise.resolve().then(() => onSave(next)).then(
      () => setMessage("Draft saved for this session."),
      () => setMessage("Draft was not saved on the server. Retry before leaving."),
    );
  }
  function leave(action: () => void) {
    if (!dirty || window.confirm("Leave without saving these changes?"))
      action();
  }
  const engineering = engineeringProblems(p),
    validation = validationProblems(p),
    ready = readinessProblems(p),
    closure = closureProblems(p);
  const step: PlanStep = p.closure.recorded || p.readyForReview || (p.validationRecorded && p.validation === "demonstrated") ? "Close"
    : p.engineeringComplete ? "Retest"
    : engineering.length === 0 ? "Accept"
    : dirty || p.milestones.some((m) => m.status !== "Not started") ? "Edit" : "Review";
  const stepIndex = PLAN_STEPS.indexOf(step);
  return (
    <section
      className="rem-workspace"
      data-testid="remediation-workspace"
      data-persona={persona}
      aria-label="POA&M remediation workspace"
    >
      {needsRetestReview && <p role="status" className="pipeline-error">The saved closure does not cover the latest measured retest. Apply the received retest and review the decisions again; downloads keep this risk open.</p>}
      <div className="rem-release-bar">
        <span>
          Recorded release <b>#{p.source.pipelineId}</b>{" "}
          <code>{p.source.commit.slice(0, 12)}</code> → Remediation release{" "}
          {p.releaseUrl ? <Reference value={p.releaseUrl}/> : <b>{p.releaseRef || "not linked"}</b>}{" "}
          {p.releaseReviewMode==="vendor-test" && <em>Automated vendor test · no independent approval</em>}
        </span>
        <button
          className="rem-text-button"
          type="button"
          onClick={() => leave(onBack)}
        >
          Release evidence →
        </button>
      </div>
      {receivedCorrection && <div className="rem-received-evidence"><span>{p.receivedVerification ? "Measured retest linked" : "Received correction available"} · #{receivedCorrection.pipelineId} · {receivedCorrection.commitSha.slice(0, 8)}</span><button type="button" className="rem-text-button" onClick={() => {
        try { setP(applyReceivedVerification(p, record, receivedCorrection)); setMessage("Received measurements applied. Review the work, then record engineering completion. ISSE validation remains separate."); }
        catch (error) { setMessage(requestMessage(error,"Could not apply received evidence.")); }
      }}>Apply received retest</button></div>}
      <div className="rem-page-content">
        <ol className="plan-stepper rem-stepper" aria-label="Plan progress">{PLAN_STEPS.map((label, index) => {
          const state = index < stepIndex || p.closure.recorded ? "done" : index === stepIndex ? "current" : "later";
          return <li key={label} data-state={state} aria-current={state === "current" ? "step" : undefined}><span>{state === "done" ? "✓" : index + 1}</span>{label}</li>;
        })}</ol>
        <div className="rem-review-header">
          <div className="rem-page-heading">
            <button
              className="rem-finding-button"
              type="button"
              onClick={() => leave(onFinding)}
            >
              ← Review item assessment
            </button>
            <h1>{p.weakness}</h1>
            <div className="rem-chips">
              {planScope(p).controls.map(id=><b key={id}>{id}</b>)}
            </div>
            <div className="rem-personas" role="group" aria-label="Review view">
              <span>Review view</span>
              {(["Engineer", "ISSE", "ISSO"] as const).map((role) => (
                <button
                  type="button"
                  key={role}
                  aria-pressed={role === persona}
                  onClick={() => {
                    setPersona(role);
                    setMessage("");
                  }}
                >
                  {role}
                </button>
              ))}
            </div>
          </div>
          <div className="rem-statuses">
            <article
              data-tone={
                p.engineeringComplete
                  ? "complete"
                  : p.milestones.some((m) => m.status !== "Not started")
                    ? "active"
                    : "pending"
              }
            >
              <span>Engineering work</span>
              <strong>
                {p.engineeringComplete
                  ? "✓ Complete"
                  : p.milestones.some((m) => m.status !== "Not started")
                    ? "● In progress"
                    : "○ Not started"}
              </strong>
            </article>
            <article
              data-tone={
                p.validationRecorded
                  ? p.validation === "demonstrated"
                    ? "complete"
                    : "active"
                  : "pending"
              }
            >
              <span>ISSE verification</span>
              <strong>
                {p.validationRecorded
                  ? p.validation === "demonstrated"
                    ? "✓ Demonstrated"
                    : "Not demonstrated"
                  : "○ Not recorded"}
              </strong>
            </article>
            <article
              data-tone={
                p.closure.recorded
                  ? "complete"
                  : p.readyForReview
                    ? "active"
                    : "pending"
              }
            >
              <span>Agency review</span>
              <strong>
                {p.closure.recorded
                  ? "External decision recorded"
                  : p.readyForReview
                    ? "Internal package prepared"
                    : "○ Not started"}
              </strong>
            </article>
            <p>A completed fix is not agency approval.</p>
          </div>
        </div>
        <div className="rem-page-grid">
          <div className="rem-main-cards" ref={mainRef}>
            {persona === "Engineer" && (
              <>
                <section className="rem-card rem-progress">
                  <div className="rem-card-heading">
                    <h2>Remediation progress</h2>
                    <span>
                      <progress
                        aria-label="Milestone completion"
                        value={
                          p.milestones.filter((m) => m.status === "Done").length
                        }
                        max={Math.max(1, p.milestones.length)}
                      />
                      {p.milestones.filter((m) => m.status === "Done").length}{" "}
                      of {p.milestones.length} milestones
                    </span>
                  </div>
                  <div className="rem-owner">
                    <Field
                      label="Responsible owner"
                      caption="Owner"
                      value={p.owner}
                      onChange={(owner) => change({ owner })}
                    />
                  </div>
                  <Milestones p={p} change={change} />
                </section>
                <div className="rem-two rem-plan-cards">
                  <section className="rem-card">
                    <Field
                      label="Corrective action"
                      value={p.action}
                      onChange={(action) => change({ action })}
                      multiline
                    />
                    <details>
                      <summary>Risk rationale and required resources</summary>
                      <Field
                        label="Risk rationale"
                        value={p.risk}
                        onChange={(risk) => change({ risk })}
                        multiline
                      />
                      <Field
                        label="Required resources"
                        value={p.resources}
                        onChange={(resources) => change({ resources })}
                        multiline
                      />
                    </details>
                  </section>
                  <section className="rem-card">
                    <Field
                      label="Interim protection"
                      value={p.protection}
                      onChange={(protection) => change({ protection })}
                      multiline
                    />
                    <details>
                      <summary>If no fix is available</summary>
                      <Field
                        label="Government risk decision reference"
                        value={p.riskDecision}
                        onChange={(riskDecision) => change({ riskDecision })}
                        hint="Referenced only. Risk decisions follow the agency process."
                      />
                    </details>
                  </section>
                </div>
                {engineering.length > 0 && (
                  <details>
                    <summary>
                      Requirements before completion · {engineering.length}
                    </summary>
                    <Issues problems={engineering} />
                  </details>
                )}
                <div className="rem-actions">
                  <button
                    className="btn ghost"
                    type="button"
                    onClick={() => {
                      setP(saved);
                      setMessage("Unsaved changes discarded.");
                    }}
                  >
                    Discard
                  </button>
                  <button
                    className={step === "Edit" ? "btn primary" : "btn ghost"}
                    type="button"
                    disabled={milestoneProblems(p).length > 0}
                    onClick={() => save("Engineering progress saved.")}
                  >
                    Save progress
                  </button>
                  <button
                    className={step === "Accept" ? "btn primary" : "btn ghost"}
                    type="button"
                    disabled={engineering.length > 0}
                    onClick={() =>
                      save(
                        "Engineering completion recorded; independent validation remains required.",
                        { engineeringComplete: true },
                      )
                    }
                  >
                    Record engineering completion
                  </button>
                </div>
              </>
            )}
            {persona === "ISSE" && (
              <>
                <div className="rem-two rem-evidence-comparison">
                  <section className="rem-card">
                    <h2>Original finding evidence</h2>
                    <p className="rem-muted">
                      Recorded #{p.source.pipelineId} · read only
                    </p>
                    <Sources record={record} names={p.source.artifacts.map(a=>a.name)} />
                  </section>
                  <section className="rem-card rem-retest-card">
                    <h2>Retest evidence</h2>
                    <p className="rem-muted">
                      {p.releaseRef || "No remediation release linked"}
                    </p>
                    {p.tests.map((t) => (
                      <div className="rem-retest-file" key={t.id}>
                        <Reference
                          value={t.evidence}
                          fallback="No artifact provided"
                        />
                      </div>
                    ))}
                  </section>
                </div>
                <section className="rem-card rem-tests">
                  <h2>Verification tests</h2>
                  <div className="rem-test-table">
                    <table>
                      <thead>
                        <tr>
                          <th>Test and evidence</th>
                          <th>Result</th>
                          <th>Reviewer</th>
                          <th>Date</th>
                        </tr>
                      </thead>
                      <tbody>
                        {p.tests.map((t) => (
                          <tr key={t.id}>
                            <td>
                              <strong>{t.description}</strong>
                              <small>
                                <Reference
                                  value={t.evidence}
                                  fallback="No artifact provided"
                                />
                              </small>
                            </td>
                            <td>{t.result || "Not recorded"}{t.artifactSha256 && <details className="rem-measurement-hash"><summary>Measured {t.verdict} · artifact hash</summary><code>{t.artifactSha256}</code></details>}</td>
                            <td>{t.reviewer || "Unassigned"}</td>
                            <td>
                              {t.date || "—"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <details>
                    <summary>Edit test records</summary>
                    <div className="rem-test-list">
                      {p.tests.map((t, i) => {
                        const update = (patch: Partial<typeof t>) =>
                          change({
                            tests: p.tests.map((item) =>
                              item.id === t.id ? { ...item, ...patch } : item,
                            ),
                          });
                        return (
                          <section key={t.id}>
                            <h3>
                              {t.description}{" "}
                              {t.illustrative && (
                                <small className="rem-example">
                                  Illustrative
                                </small>
                              )}
                            </h3>
                            <div className="rem-two">
                              <Field
                                label={`Evidence reference ${i + 1}`}
                                value={t.evidence}
                                onChange={(evidence) =>
                                  update({
                                    evidence,
                                    illustrative: p.assessment.illustrative,
                                  })
                                }
                              />
                              <Field
                                label={`Test result ${i + 1}`}
                                value={t.result}
                                onChange={(result) => update({ result })}
                              />
                              <Field
                                label={`Test reviewer ${i + 1}`}
                                value={t.reviewer}
                                onChange={(reviewer) => update({ reviewer })}
                              />
                              <Field
                                label={`Test date ${i + 1}`}
                                type="date"
                                value={t.date}
                                onChange={(date) => update({ date })}
                              />
                            </div>
                          </section>
                        );
                      })}
                    </div>
                  </details>
                </section>
                <section className="rem-card rem-validation">
                  <fieldset className="rem-options">
                    <legend>
                      Does the evidence verify the fix?
                    </legend>
                    {[
                      ["undetermined", "Not yet determined"],
                      ["demonstrated", "Demonstrated"],
                      ["not-demonstrated", "Not demonstrated"],
                    ].map(([value, label]) => (
                      <label key={value}>
                        <input
                          type="radio"
                          name="validation"
                          checked={p.validation === value}
                          onChange={() =>
                            change({
                              validation:
                                value as RemediationPlan["validation"],
                            })
                          }
                        />
                        <span>{label}</span>
                      </label>
                    ))}
                  </fieldset>
                  <details>
                    <summary>
                      Verification record ·{" "}
                      {p.validator ? "Reviewer recorded" : "Unassigned reviewer"} ·{" "}
                      {p.validationDate || "No date"}
                    </summary>
                    <Field
                      label="Verification rationale"
                      value={p.validationNote}
                      onChange={(validationNote) => change({ validationNote })}
                      multiline
                    />
                    <div className="rem-two">
                      <Field
                        label="ISSE reviewer"
                        value={p.validator}
                        onChange={(validator) => change({ validator })}
                      />
                      <Field
                        label="Verification date"
                        type="date"
                        value={p.validationDate}
                        onChange={(validationDate) =>
                          change({ validationDate })
                        }
                      />
                    </div>
                  </details>
                  {validation.length > 0 && <details className="rem-validation-requirements"><summary>Requirements · {validation.length}</summary><Issues problems={validation} /></details>}
                </section>
                  <div className="rem-actions">
                    <button
                      className="btn ghost"
                      type="button"
                      onClick={() =>
                        save("Verification notes saved; outcome not recorded.")
                      }
                    >
                      Save notes
                    </button>
                    <button
                      className={step === "Retest" ? "btn primary" : "btn ghost"}
                      type="button"
                      disabled={validation.length > 0}
                      onClick={() =>
                        save(`ISSE validation recorded: ${p.validation}.`, {
                          validationRecorded: true,
                        })
                      }
                    >
                      Record validation
                    </button>
                  </div>
              </>
            )}
            {persona === "ISSO" && (
              <>
                <div className="rem-two rem-readiness">
                  <section className="rem-card">
                    <h2>Internal package readiness</h2>
                    <ReadinessRow
                      good={p.engineeringComplete && !engineering.length}
                      label="Engineering work complete"
                      detail={`${p.milestones.filter((m) => m.status === "Done").length} of ${p.milestones.length} milestones`}
                      action={() => setPersona("Engineer")}
                      actionLabel="Engineer view →"
                    />
                    <ReadinessRow
                      good={!!p.releaseRef}
                      label="Remediation linked"
                      detail={p.releaseRef || "Not linked"}
                      action={() => setPersona("Engineer")}
                      actionLabel="Engineer view →"
                    />
                    <ReadinessRow
                      good={p.tests.every(
                        (t) => t.evidence && t.result && t.reviewer && t.date,
                      )}
                      label="Retest recorded"
                      detail={`${p.tests.length} required test records`}
                      action={() => setPersona("ISSE")}
                      actionLabel="ISSE view →"
                    />
                    <ReadinessRow
                      good={
                        p.validationRecorded &&
                        p.validation === "demonstrated" &&
                        !validation.length
                      }
                      label="ISSE validation"
                      detail={
                        p.validationRecorded ? p.validation : "Not recorded"
                      }
                      action={() => setPersona("ISSE")}
                      actionLabel="ISSE view →"
                    />
                  </section>
                  <section className="rem-card">
                    <h2>Agency process readiness</h2>
                    <ReadinessRow
                      good={!!p.repository.trim()}
                      label="Agency-designated repository"
                      detail={p.repository || "Not specified"}
                    />
                    <ReadinessRow
                      good={!!p.officialId.trim()}
                      label="Official POA&M ID"
                      detail={p.officialId || "Not recorded"}
                    />
                    <ReadinessRow
                      good={!!p.protectionDisposition.trim()}
                      label="Interim protection disposition"
                      detail={
                        p.protectionDisposition || "Keep or remove to confirm"
                      }
                    />
                    <ReadinessRow
                      good={false}
                      label="Other review items"
                      detail={`${planScope(p).remainingScope.length} for separate review`}
                      action={() => leave(onFinding)}
                      actionLabel="Review item assessment →"
                    />
                  </section>
                </div>
                <section className="rem-card rem-closure">
                  <div className="rem-card-heading">
                    <h2>Agency closure decision</h2>
                    <span>Agency approval stays external</span>
                  </div>
                  <div className="rem-closure-fields">
                    <Field
                      label="External approval reference"
                      caption="Approval reference"
                      value={p.closure.reference}
                      onChange={(reference) =>
                        change({ closure: { ...p.closure, reference } })
                      }
                    />
                    <Field
                      label="External approver"
                      caption="Approver"
                      value={p.closure.approver}
                      onChange={(approver) =>
                        change({ closure: { ...p.closure, approver } })
                      }
                    />
                    <Field
                      label="Decision date"
                      type="date"
                      value={p.closure.date}
                      onChange={(date) =>
                        change({ closure: { ...p.closure, date } })
                      }
                    />
                    <Field
                      label="Decision official POA&M ID"
                      caption="Official POA&M ID"
                      value={p.closure.officialId}
                      onChange={(officialId) =>
                        change({ closure: { ...p.closure, officialId } })
                      }
                    />
                  </div>
                  <Field
                    label="Interim protection disposition"
                    value={p.protectionDisposition}
                    onChange={(protectionDisposition) =>
                      change({ protectionDisposition })
                    }
                  />
                  {(p.readyForReview ? closure : ready).length > 0 && (
                    <details>
                      <summary>
                        Required before{" "}
                        {p.readyForReview
                          ? "recording closure"
                          : "internal handoff"}{" "}
                        · {(p.readyForReview ? closure : ready).length}
                      </summary>
                      <Issues problems={p.readyForReview ? closure : ready} />
                    </details>
                  )}
                  <p className="rem-muted">
                    Record an existing decision · required fields stay enforced.
                  </p>
                </section>
                <div className="rem-actions">
                  <button
                    className="btn ghost"
                    type="button"
                    onClick={() =>
                      save("ISSO record linkage and closure notes saved.")
                    }
                  >
                    Save review notes
                  </button>
                  <button
                    className={step === "Close" && p.readyForReview && !p.closure.recorded ? "btn primary" : "btn ghost"}
                    type="button"
                    disabled={closure.length > 0}
                    onClick={() =>
                      save(
                        "External agency closure decision reference recorded; application did not approve closure.",
                        { closure: { ...p.closure, recorded: true } },
                      )
                    }
                  >
                    Record agency closure decision
                  </button>
                  <button
                    className={step === "Close" && !p.readyForReview ? "btn primary" : "btn ghost"}
                    type="button"
                    disabled={ready.length > 0}
                    onClick={() =>
                      save(
                        "Internal package marked ready for closure review; no submission performed.",
                        { readyForReview: true },
                      )
                    }
                  >
                    Mark ready for closure review
                  </button>
                </div>
                <p className="rem-status-note">
                  Internal handoff only · no agency submission
                </p>
              </>
            )}
            <p role="status" className="rem-message">
              {message}
              {dirty && !message ? "Unsaved changes" : ""}
            </p>
          </div>
          <aside className="rem-linkage">
            <div className="rem-card-heading">
              <h2>Record linkage</h2>
              <span>Manual · no sync</span>
            </div>
            <button type="button" className="btn ghost" onClick={() => { setResultsOpen(false); setPlanOpen(true); }}>View plan of action</button>
            <button type="button" className="btn ghost" onClick={() => { setPlanOpen(false); setResultsOpen(true); }}>View assessment results</button>
            <p className="rem-muted">Plain-language views of this draft. Each download is an OSCAL file, not the internal draft JSON.</p>
            <dl>
              <dt>Draft identifier</dt>
              <dd>
                <code>{p.id}</code>
              </dd>
              <dt>Agency-designated repository</dt>
              <dd>{p.repository || <i>Not specified</i>}</dd>
              <dt>Official POA&M ID</dt>
              <dd>{p.officialId || <i>Not recorded</i>}</dd>
              <dt>Engineering ticket</dt>
              <dd>{p.ticket || <i>Not linked</i>}</dd>
              <dt>Remediation release</dt>
              <dd>
                {p.releaseRef || <i>Not linked</i>}
                {p.releaseIllustrative && (
                  <small className="rem-example">Sample</small>
                )}
              </dd>
            </dl>
            <details className="rem-linkage-edit">
              <summary>Edit record linkage</summary>
              <p className="rem-muted">
                Confirm the approved repository with the agency ISSO. References
                are not fetched or verified.
              </p>
              <Field
                label="Assessment reference"
                value={p.assessment.reference}
                onChange={() => {}}
                readOnly
                hint="Read only · saved with the assessment"
              />
              <LinkageFields p={p} change={change} />
              <Field
                label="Remediation release reference"
                value={p.releaseRef}
                onChange={(releaseRef) => change({ releaseRef })}
              />
              <Field
                label="Remediation release URL"
                value={p.releaseUrl}
                onChange={(releaseUrl) => change({ releaseUrl })}
              />
              <label className="rem-checkbox">
                <input
                  type="checkbox"
                  checked={p.releaseIllustrative}
                  disabled={p.assessment.illustrative}
                  onChange={(e) =>
                    change({ releaseIllustrative: e.target.checked })
                  }
                />
                <span>Sample remediation release</span>
              </label>
            </details>
            {p.releaseUrl && <Reference value={p.releaseUrl} />}
            <hr />
            <h3>Back to</h3>
            <button
              className="rem-text-button"
              type="button"
              onClick={() => leave(onFinding)}
            >
              Review item assessment →
            </button>
            <button
              className="rem-text-button"
              type="button"
              onClick={() => leave(onBack)}
            >
              Release evidence →
            </button>
            <button
              className="rem-text-button"
              type="button"
                disabled={!onControl}
                onClick={() => {if(onControl) leave(onControl);}}
            >
                Open {p.control} in Level 2 →
            </button>
            <details className="rem-linkage-history">
              <summary>History · {p.history.length} entries</summary>
              <p className="rem-muted">
                Local change log, not an independently verified audit trail.
              </p>
              <ol className="rem-history">
                {p.history.map((h, i) => (
                  <li key={i}>
                    <time>{h.at.slice(0, 16).replace("T", " ")} UTC</time>
                    {h.action}
                  </li>
                ))}
              </ol>
            </details>
            <details className="rem-review-actions">
              <summary>Review actions</summary>
              <p className="rem-muted">Reopen internal review decisions. Recorded milestones, assessment and pipeline measurements stay unchanged.</p>
              <button type="button" className="rem-text-button" disabled={p.closure.recorded || dirty} onClick={() => {
                const next = resetReviewDecisions(p, new Date().toISOString());
                setP(next);
                setMessage("Saving review reset…");
                void Promise.resolve().then(() => onSave(next)).then(
                  () => setMessage("Review decisions reset. Recorded work and evidence preserved."),
                  () => setMessage("Reset was not saved on the server. Retry before leaving."),
                );
              }}>Reset review decisions</button>
            </details>
            {p.assessment.illustrative && p.control==="SC-7" && persona !== "ISSO" && <details key={persona} className="rem-example-tools"><summary>Example setup</summary><button className="rem-text-button" type="button" onClick={() => { setP(illustrativeProgress(p, persona === "ISSE")); setMessage("Demo example loaded. No external system changed."); }}>{persona === "Engineer" ? "Load sample progress" : "Load sample retest"}</button></details>}
            <details className="rem-handling"><summary>Handling & scope</summary><p>Saved with this browser session. Use only data approved for this environment. References are manual; no agency submission or synchronization. Review views are not access permissions. Verification is reviewer-entered, not inferred from pipeline pass. Neither OSCAL download is an agency acceptance.</p><p>Outside this item: {remainingScope(p)}</p><p>Assessment source: {p.assessment.illustrative ? "Prepared sample record" : "Reviewer-entered record"}. Retest source: {p.releaseIllustrative ? "Sample results" : p.receivedVerification ? "Received pipeline measurements" : "Manually supplied references"}.</p></details>
            <details>
              <summary>Import engineering evidence</summary>
              {!receivedCorrection && record.reviewItems?.find(item=>item.description===p.source.reviewItem)?.retestPacketUrl && <button type="button" className="rem-text-button" onClick={async()=>{
                try {
                  const href=record.reviewItems!.find(item=>item.description===p.source.reviewItem)!.retestPacketUrl!;
                  if(!/^\/samples\/remediation\/[a-z0-9-]+\.json$/.test(href)) throw new Error("Invalid local retest template.");
                  const response=await fetch(href,{credentials:"omit"});
                  if(!response.ok) throw new Error("Could not load the recorded retest packet.");
                  const text=await response.text(); if(text.length>512000) throw new Error("Retest packet exceeds the local import limit.");
                  setP(applyRetestPacket(p,JSON.parse(text)));setMessage("Recorded retest loaded. Completion and security validation remain separate review actions.");
                } catch(error){setMessage(requestMessage(error,"Could not load recorded retest."));}
              }}>Load recorded retest</button>}
              <label className="pipeline-import">Retest packet JSON<input type="file" accept=".json,application/json" aria-label="Import retest packet JSON" onChange={async event=>{
                const file=event.currentTarget.files?.[0];event.currentTarget.value="";if(!file)return;
                try{if(file.size>512000)throw new Error("Use a retest packet smaller than 500 KB.");setP(applyRetestPacket(p,JSON.parse(await file.text())));setMessage("Retest imported locally. Review and record engineering completion; security validation stays unrecorded.");}
                catch(error){setMessage(requestMessage(error,"Could not import retest evidence."));}
              }}/></label>
              <p className="rem-muted">Bound to the original release. Import does not verify signatures or record approval.</p>
            </details>
            <button
              className="btn ghost"
              type="button"
              onClick={() => {
                download(p);
                setMessage(
                  "Exported the internal draft JSON. Assessment results and plan of action download the OSCAL files.",
                );
              }}
            >
              Export draft
            </button>
            <small>
              Internal JSON draft. Assessment results and plan of action are the OSCAL files.
            </small>
          </aside>
        </div>
      </div>
      {planOpen && <PlanOfActionView plan={p} onClose={() => setPlanOpen(false)} onSave={onSave} />}
      {resultsOpen && <AssessmentResultsView plan={p} onClose={() => setResultsOpen(false)} onSave={onSave} />}
    </section>
  );
}
function ReadinessRow({
  good,
  label,
  detail,
  action,
  actionLabel,
}: {
  good: boolean;
  label: string;
  detail: string;
  action?: () => void;
  actionLabel?: string;
}) {
  return (
    <div className="rem-readiness-row">
      <b className={good ? "good" : "rem-pending"}>{good ? "✓" : "○"}</b>
      <div>
        <strong>{label}</strong>
        <small>{detail}</small>
      </div>
      {action && (
        <button className="rem-text-button" type="button" onClick={action}>
          {actionLabel}
        </button>
      )}
    </div>
  );
}
export { newPlan };
