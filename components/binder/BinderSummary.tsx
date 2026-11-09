"use client";
import { EvidenceGraph } from "./EvidenceGraph";
import { SourceRepo, SystemSources } from "./SourceRepo";
import React, { useEffect, useMemo, useState } from "react";
import {
  evidenceByControl,
  evidenceInventoryRecords,
  planNeedsDecision,
} from "@/lib/collector/control-evidence";
import {
  artifactSourceKey,
  currentArtifactSources,
} from "@/lib/aegis/artifact-sources";
import { evidenceViewerHref } from "@/lib/builder/evidence-links";
import {
  gitlabArtifactUrl,
  pipelineArtifactNames,
  type PipelineEvidence,
} from "@/lib/aegis/pipeline-evidence";
import type { ArtifactMappingProposal } from "@/lib/aegis/artifact-mapping";
import type { ArtifactMappingDecision, CatalogId } from "@/lib/aegis/types";
import type { PlanProposal } from "@/lib/aegis/plan-proposal";
import { utcTime, requestMessage } from "@/lib/builder/presentation";

export type ArtifactArrivalState = {
  request: { id: number; sourceKey: string } | null;
  counts: Map<string, number>;
};
type Props = {
  record: PipelineEvidence;
  controlIds: string[];
  catalogId?: CatalogId;
  records?: PipelineEvidence[];
  arrival?: ArtifactArrivalState;
  decisions?: ArtifactMappingDecision[];
  controlTitles?: Record<string, string>;
  plans?: PlanProposal[];
  onOpenPlan?: (id: string) => void;
  onOpenMap?: () => void;
  storageNote?: string | null;
  onDecision?: (
    proposal: ArtifactMappingProposal,
    status: "accepted" | "rejected",
    controls?: string[],
    reviewer?: string,
    source?: PipelineEvidence,
  ) => Promise<void>;
};
const EMPTY_RECORDS: PipelineEvidence[] = [],
  EMPTY_DECISIONS: ArtifactMappingDecision[] = [];
export function BinderSummary({
  record,
  controlIds,
  catalogId,
  records = EMPTY_RECORDS,
  arrival,
  decisions = EMPTY_DECISIONS,
  controlTitles = {},
  plans = [],
  onOpenPlan,
  onOpenMap,
  onDecision,
  storageNote,
}: Props) {
  const source = useMemo(()=>evidenceInventoryRecords(record,records),[record,records]);
  const index = useMemo(
    () => evidenceByControl(source, controlIds, catalogId, decisions),
    [source, controlIds, catalogId, decisions],
  );
  const repositories = [
    ...new Map(
      index.files.flatMap((file) =>
        file.collected
          ? [
              [
                `${file.collected.source.repo}:${file.collected.source.commit}`,
                file.collected.source,
              ] as const,
            ]
          : [],
      ),
    ).values(),
  ];
  const retainedCount = source.reduce(
    (count, item) => count + pipelineArtifactNames(item).length,
    0,
  );
  const rows = index.files;
  const sourceKey = source
    .map((item) => item.releaseSha256)
    .sort()
    .join(":");
  const request =
    arrival?.request?.sourceKey === sourceKey ? arrival.request : null;
  const progressKey = `${request?.id ?? "retained"}:${sourceKey}`;
  const initialCount = request
    ? (arrival?.counts.get(progressKey) ?? 0)
    : rows.length;
  const [progress, setProgress] = useState({
    key: progressKey,
    count: initialCount,
  });
  const received = Math.min(
    progress.key === progressKey ? progress.count : initialCount,
    rows.length,
  );
  useEffect(() => {
    if (received >= rows.length) return;
    const timer = setTimeout(() => {
      const count = Math.min(
        rows.length,
        received + Math.max(1, Math.ceil(rows.length / 40)),
      );
      arrival?.counts.set(progressKey, count);
      setProgress({ key: progressKey, count });
    }, 150);
    return () => clearTimeout(timer);
  }, [progressKey, rows.length, received, arrival?.counts]);
  const [selectedId, setSelectedId] = useState<string | null>(null),
    [reviewer, setReviewer] = useState(""),
    [saving, setSaving] = useState<string | null>(null),
    [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setSelectedId(null);
    setError(null);
  }, [sourceKey]);
  const [showMoreSuggestions, setShowMoreSuggestions] = useState(false);
  useEffect(() => setShowMoreSuggestions(false), [selectedId, sourceKey]);
  const selected = index.controls.find((c) => c.id === selectedId);
  const linked = index.controls.filter((c) => c.evidence.length),
    suggested = index.controls.filter((c) => c.suggested.length);
  const latest = currentArtifactSources(source);
  const openPlans = plans.filter(
    (plan) => plan.controlId === selectedId && !plan.closureConfirmed,
  );
  async function decide(
    file: (typeof rows)[number],
    status: "accepted" | "rejected",
  ) {
    if (!file.proposal || !onDecision || !selectedId) return;
    setSaving(file.key);
    setError(null);
    try {
      await onDecision(
        file.proposal,
        status,
        [selectedId],
        reviewer,
        file.source,
      );
    } catch (cause) {
      setError(requestMessage(cause, "Could not store the mapping decision."));
    } finally {
      setSaving(null);
    }
  }
  function fileLink(file: (typeof rows)[number]) {
    const href =
      file.collected?.source.url ?? gitlabArtifactUrl(file.source, file.name);
    return (
      <a
        href={evidenceViewerHref(href ?? undefined, undefined, file.source)}
        target="_blank"
        rel="noopener noreferrer"
      >
        {file.collected?.source.path ?? file.name} ↗
      </a>
    );
  }
  return (
    <section
      className="release-card binder-summary evidence-by-control"
      data-testid="binder-summary"
    >
      <div className="release-section-title">
        <h2>Evidence in this release</h2>
        <span role="status" data-testid="artifact-arrival-count">
          {received} files collected ·{" "}
          {received < rows.length ? "loading recorded files…" : "complete"}
        </span>
      </div>
      <div className="evidence-control-layout">
        <EvidenceGraph key={sourceKey} controls={index.controls} titles={controlTitles} plans={plans} selected={selectedId} onSelect={setSelectedId} />
        {selected && (
          <div
            className="control-evidence-drill"
            aria-label={`${selected.id} evidence details`}
          >
            <div className="release-section-title">
              <h3>
                <code>{selected.id}</code> {controlTitles[selected.id]}
              </h3>
              <button
                type="button"
                className="icon-btn"
                aria-label="Close control evidence"
                onClick={() => setSelectedId(null)}
              >
                ×
              </button>
            </div>
            <h4>Evidence</h4>
            {selected.evidence.map((file) => (
              <article key={file.key} className="control-linked-file">
                {fileLink(file)}
                <small>
                  {file.approved.includes(selected.id)
                    ? `Accepted by ${file.decision?.reviewer || "a person"}${file.decision?.decidedAt ? ` · ${utcTime(file.decision.decidedAt, true)}` : ""}`
                    : "Declared by pipeline"}
                </small>
                {file.collected && (
                  <SourceRepo source={file.collected.source} />
                )}
              </article>
            ))}
            {!selected.evidence.length && (
              <p className="release-note">No evidence linked yet.</p>
            )}
            {selected.suggested.length > 0 && (
              <>
                <h4>Suggested · nobody has reviewed these</h4>
                {storageNote && (
                  <p role="status" className="hint">
                    {storageNote}
                  </p>
                )}
                {onDecision && (
                  <label className="rem-field">
                    <span>Mapping reviewer</span>
                    <input
                      aria-label="Mapping reviewer"
                      value={reviewer}
                      maxLength={200}
                      onChange={(e) => setReviewer(e.target.value)}
                    />
                  </label>
                )}
                {(showMoreSuggestions
                  ? selected.suggested
                  : selected.suggested.slice(0, 1)
                ).map((file) => (
                  <article key={file.key}>
                    {fileLink(file)}
                    {file.collected && (
                      <p>
                        <SourceRepo source={file.collected.source} />
                      </p>
                    )}
                    <p className="release-note">
                      {
                        file.proposal?.candidates.find(
                          (candidate) => candidate.controlId === selected.id,
                        )?.reasons[0]
                      }
                    </p>
                    <details>
                      <summary>More source details</summary>
                      {file.proposal?.candidates
                        .find((c) => c.controlId === selected.id)
                        ?.reasons.slice(1)
                        .map((reason) => (
                          <p key={reason}>{reason}</p>
                        ))}
                      {file.collected?.facts.map((fact) => (
                        <p key={`${fact.key}:${fact.line}:${fact.field}`}>
                          Line {fact.line}: {fact.content}
                        </p>
                      ))}
                    </details>
                    {onDecision &&
                      file.proposal &&
                      latest.get(artifactSourceKey(file.source, file.name)) ===
                        file.source && (
                        <div className="mapping-proposal-actions">
                          <button
                            type="button"
                            className="btn ghost"
                            disabled={saving !== null || !reviewer.trim()}
                            onClick={() => void decide(file, "accepted")}
                          >
                            Accept as evidence
                          </button>
                          <button
                            type="button"
                            className="btn ghost"
                            disabled={saving !== null}
                            onClick={() => void decide(file, "rejected")}
                          >
                            Dismiss
                          </button>
                        </div>
                      )}
                  </article>
                ))}
                {selected.suggested.length > 1 && (
                  <button
                    type="button"
                    className="coverage-text-action"
                    aria-expanded={showMoreSuggestions}
                    onClick={() => setShowMoreSuggestions(!showMoreSuggestions)}
                  >
                    {showMoreSuggestions
                      ? "Show fewer suggestions"
                      : `Show ${selected.suggested.length - 1} more suggested files →`}
                  </button>
                )}
              </>
            )}
            {error && (
              <p role="alert" className="pipeline-error">
                {error}
              </p>
            )}
            {openPlans.length > 0 && (
              <>
                <h4>
                  Open plans on {selected.id} ·{" "}
                  {openPlans.some(planNeedsDecision)
                    ? "waiting on you"
                    : "waiting on a retest"}
                </h4>
                {openPlans.map((plan) => (
                  <article key={plan.id} className="control-open-plan">
                    <strong>{plan.findingTitle}</strong>
                    <small>
                      {plan.readyToClose
                        ? "Fixed: the retest passed"
                        : plan.acceptance === "accepted"
                          ? "Waiting on a retest"
                          : "Not fixed: a plan is drafted"}
                    </small>
                    <button
                      type="button"
                      className="btn primary"
                      onClick={() => onOpenPlan?.(plan.id)}
                    >
                      {plan.readyToClose
                        ? "Confirm closure →"
                        : "Review plan →"}
                    </button>
                  </article>
                ))}
              </>
            )}
          </div>
        )}
      </div>
      <details className="binder-summary-notes">
        <summary>Details and limitations</summary>
        {repositories.length > 0 && (
          <p className="release-note" data-testid="summary-source-repos">
            Source repositories: <SystemSources sources={repositories} />
          </p>
        )}
        {retainedCount > rows.length && (
          <p className="release-note">
            {retainedCount} artifact versions retained in receipt history.
          </p>
        )}
        <p className="release-note">
          Evidence links show coverage only. Suggested links come from rules and
          require a person’s review. Source definitions do not prove execution,
          control satisfaction or authorization.
        </p>
      </details>
    </section>
  );
}
