"use client";
import { requestMessage } from "@/lib/builder/presentation";

import { useState } from "react";
import { hasRecordedTestResult, planOfActionFacts } from "@/lib/aegis/poam-facts";
import type { RemediationPlan } from "@/lib/aegis/remediation";
import { useDialogFocus } from "./useDialogFocus";

const METHOD_LABEL: Record<string, string> = {
  EXAMINE: "Examine",
  INTERVIEW: "Interview",
  TEST: "Test",
  UNKNOWN: "Not recorded",
};

export function AssessmentResultsView({
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
  const finding = facts.finding || facts.observation || facts.weakness;
  async function download() {
    setBusy(true);
    setError("");
    try {
      await onSave(plan);
      const response = await fetch(`/api/remediation/assessment-results?id=${encodeURIComponent(plan.id)}`, { cache: "no-store" });
      if (!response.ok) throw new Error("The assessment results file could not be downloaded.");
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "assessment-results.json";
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (cause) {
      setError(requestMessage(cause,"The assessment results file could not be downloaded."));
    } finally {
      setBusy(false);
    }
  }
  async function downloadPlan() {
    setBusy(true);
    setError("");
    try {
      await onSave(plan);
      const response = await fetch(`/api/remediation/system-security-plan?id=${encodeURIComponent(plan.id)}`, { cache: "no-store" });
      if (!response.ok) throw new Error("The system security plan could not be downloaded.");
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "system-security-plan.json";
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (cause) {
      setError(requestMessage(cause,"The system security plan could not be downloaded."));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="rem-overlay">
      <section ref={ref} tabIndex={-1} className="rem-drawer rem-draft-drawer poam-view" role="dialog" aria-modal="true" aria-labelledby="assessment-results-title" data-testid="assessment-results">
        <header>
          <h2 id="assessment-results-title">Assessment results</h2>
          <span>{facts.closureRecorded ? "Closure decision recorded" : "Open"}</span>
          <button type="button" onClick={onClose} aria-label="Close assessment results">×</button>
        </header>
        <div className="rem-drawer-body">
          <p className="rem-muted">Plain-language view of this saved assessment and its source release. The download is the OSCAL file, not the internal draft.</p>
          <dl className="poam-facts">
            <dt>Finding</dt>
            <dd>{finding || "Not recorded"}</dd>
            <dt>Checked by</dt>
            <dd>{facts.methods.map((method) => METHOD_LABEL[method] ?? method).join(" · ")}</dd>
            <dt>Control</dt>
            <dd>{facts.controls.length ? facts.controls.join(" · ") : "Not selected"} <small>reviewer-selected</small></dd>
            <dt>Source pipeline</dt>
            <dd>#{plan.source.pipelineId}</dd>
            <dt>Corrective release</dt>
            <dd>{facts.correctiveRelease.identity || "Not recorded"}{plan.releaseIllustrative && facts.correctiveRelease.identity ? <small className="rem-example">Sample</small> : null}</dd>
            <dt>Risk</dt>
            <dd>{facts.closureRecorded ? "Closure decision recorded" : "Open"}</dd>
          </dl>
          <h3>Verification checks</h3>
          {facts.retests.length ? (
            <ol className="poam-list">
              {facts.retests.map((test) => (
                <li key={test.description}>
                  <strong>{test.description || "Untitled check"}</strong>
                  <small>{!hasRecordedTestResult(test) ? "Awaiting result" : !test.evidence.trim() ? "Result recorded · evidence unlinked" : test.illustrative ? "Sample evidence" : "Recorded evidence"}{hasRecordedTestResult(test) && test.verdict ? ` · ${test.verdict.toUpperCase()}` : ""}</small>
                </li>
              ))}
            </ol>
          ) : <p className="rem-muted">No verification check recorded.</p>}
          <details>
            <summary>Assessment plan & objective</summary>
            <p className="rem-muted">The download includes an internal OSCAL assessment plan and scoped workload context. Its local objective is the saved requirement below—not the whole control or an agency-approved objective.</p>
            <p>{plan.assessment.requirement}</p>
            <p className="rem-muted">ISSE verification evaluates this requirement. Agency risk acceptance remains separate.</p>
          </details>
          <details>
            <summary>Left blank</summary>
            <ul className="poam-list">
              <li>Agency system identifier</li>
              {!facts.officialPoamId && <li>Official POA&M ID</li>}
              {!facts.repository && <li>Agency-designated repository</li>}
              {!facts.closureRecorded && <li>Closure decision</li>}
              <li>Review items other than this recorded finding</li>
            </ul>
            <p className="rem-muted">No agency identifiers or approvals are inferred. Attached context documents do not copy the internal draft JSON.</p>
          </details>
          {error && <p role="alert" className="pipeline-error">{error}</p>}
        </div>
        <footer>
          <button type="button" className="btn primary" disabled={busy} onClick={() => void download()}>Download OSCAL assessment results</button>
          <button type="button" className="btn ghost" disabled={busy} onClick={() => void downloadPlan()}>Download OSCAL system security plan</button>
          <small>Assessment results and the system security plan use the latest stored result per control. Agency acceptance is outside this export.</small>
        </footer>
      </section>
    </div>
  );
}
