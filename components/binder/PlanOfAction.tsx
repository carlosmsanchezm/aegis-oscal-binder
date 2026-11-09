"use client";
import { requestMessage } from "@/lib/builder/presentation";

import React, { useState } from "react";
import { hasRecordedTestResult, planOfActionFacts } from "@/lib/aegis/poam-facts";
import type { RemediationPlan } from "@/lib/aegis/remediation";
import { useDialogFocus } from "./useDialogFocus";

export function PlanOfActionView({
  plan,
  onClose,
  onSave,
}: {
  plan: RemediationPlan;
  onClose: () => void;
  onSave: (plan: RemediationPlan) => void | Promise<void>;
}) {
  const facts = planOfActionFacts(plan);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const ref = useDialogFocus(onClose);
  async function download() {
    setBusy(true);
    setError("");
    try {
      await onSave(plan);
      const response = await fetch(`/api/remediation/oscal?id=${encodeURIComponent(plan.id)}`, { cache: "no-store" });
      if (!response.ok) throw new Error("The plan of action file could not be downloaded.");
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "plan-of-action-and-milestones.json";
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (cause) {
      setError(requestMessage(cause,"The plan of action file could not be downloaded."));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="rem-overlay">
      <section ref={ref} tabIndex={-1} className="rem-drawer rem-draft-drawer poam-view" role="dialog" aria-modal="true" aria-labelledby="poam-title" data-testid="plan-of-action">
        <header>
          <h2 id="poam-title">Plan of action</h2>
          <span>{facts.closureRecorded ? "Closure decision recorded" : "Open"}</span>
          <button type="button" onClick={onClose} aria-label="Close plan of action">×</button>
        </header>
        <div className="rem-drawer-body">
          <p className="rem-muted">Plain-language view of this saved draft. The download is an OSCAL 1.1.2 plan of action file. Agency review stays in the agency process.</p>
          <dl className="poam-facts">
            <dt>Weakness</dt>
            <dd>{facts.weakness || "Not described"}</dd>
            {facts.finding && facts.finding !== facts.weakness && <><dt>Finding</dt><dd>{facts.finding}</dd></>}
            <dt>Risk</dt>
            <dd>{facts.riskStatement || "Not recorded"}</dd>
            {facts.action && <><dt>Corrective action</dt><dd>{facts.action}</dd></>}
            <dt>Control</dt>
            <dd>{facts.controls.length ? facts.controls.join(" · ") : "Not selected"} <small>reviewer-selected</small></dd>
            <dt>Owner</dt>
            <dd>{facts.owner || "Not assigned"}</dd>
          </dl>
          <h3>Milestones</h3>
          {facts.milestones.length ? (
            <ol className="poam-list">
              {facts.milestones.map((milestone, index) => (
                <li key={`${milestone.description}:${index}`}>
                  <strong>{milestone.description || "Untitled milestone"}</strong>
                  <small>{milestone.status} · target {milestone.target || "none"}{milestone.revised ? ` · revised ${milestone.revised}` : ""}</small>
                  {milestone.reason.trim() ? <p>{milestone.reason}</p> : null}
                </li>
              ))}
            </ol>
          ) : <p className="rem-muted">No milestones recorded.</p>}
          <h3>Retest evidence</h3>
          {facts.retests.length ? (
            <ol className="poam-list">
              {facts.retests.map((test) => (
                <li key={test.description}>
                  <strong>{test.description || "Untitled retest"}</strong>
                  <p>{test.result.trim() || "No result recorded."}</p>
                  <small>{!hasRecordedTestResult(test) ? "Awaiting result" : !test.evidence.trim() ? "Result recorded · evidence unlinked" : test.illustrative ? "Sample evidence" : "Recorded evidence"}{hasRecordedTestResult(test) && test.verdict ? ` · ${test.verdict.toUpperCase()}` : ""}</small>
                  {test.href ? <a href={test.href} target="_blank" rel="noopener noreferrer">Evidence ↗</a> : <span>{test.evidence.trim() || "No evidence linked."}</span>}
                </li>
              ))}
            </ol>
          ) : <p className="rem-muted">No retest recorded.</p>}
          <h3>Still open</h3>
          <ul className="poam-list">
            {facts.stillOpen.filter(item => !item.startsWith("Outside this item:")).map((item) => <li key={item}>{item}</li>)}
          </ul>
          <details>
            <summary>Assessment & decision record</summary>
            <dl className="poam-facts">
              <dt>Asset</dt><dd>{plan.asset || "Not recorded"}</dd>
              <dt>Requirement</dt><dd>{plan.assessment.requirement || "Not recorded"}</dd>
              <dt>Assessment</dt><dd>{plan.assessment.reference} · {plan.assessment.reviewer} · {plan.assessment.date}</dd>
              <dt>Rationale</dt><dd>{plan.assessment.note || "Not recorded"}</dd>
              <dt>ISSE verification</dt><dd>{plan.validationRecorded ? plan.validation : "Not recorded"}{plan.validator ? ` · ${plan.validator}` : ""}{plan.validationDate ? ` · ${plan.validationDate}` : ""}</dd>
              <dt>Verification rationale</dt><dd>{plan.validationNote || "Not recorded"}</dd>
              <dt>Resources</dt><dd>{plan.resources || "Not recorded"}</dd>
              <dt>Interim protection</dt><dd>{plan.protection || "Not recorded"}</dd>
              <dt>External decision</dt><dd>{facts.closureRecorded ? `${plan.closure.reference} · ${plan.closure.approver} · ${plan.closure.date}` : "Not recorded with complete closure requirements"}</dd>
            </dl>
            <p className="rem-muted">The download preserves these fields, evidence hashes when supplied, and the internal decision record. Recorded references are not independent approval or agency submission.</p>
            <p className="rem-muted">The OSCAL system binding identifies the internal scoped workload. It is not an agency system ID or authorization boundary.</p>
          </details>
          <details>
            <summary>Left blank in the OSCAL file</summary>
            <ul className="poam-list">
              <li>Agency system identifier</li>
              {!facts.officialPoamId && <li>Official POA&M ID</li>}
              {!facts.repository && <li>Agency-designated repository</li>}
            </ul>
            <p className="rem-muted">The file contains this draft only. Review items outside it are not added as findings.</p>
          </details>
          {error && <p role="alert" className="pipeline-error">{error}</p>}
        </div>
        <footer>
          <button type="button" className="btn primary" disabled={busy} onClick={() => void download()}>Download OSCAL plan of action</button>
          <small>One plan-of-action-and-milestones file. Agency acceptance is outside this export.</small>
        </footer>
      </section>
    </div>
  );
}
