"use client";
import {SourceRepo,SystemSources} from "./SourceRepo";
import { requestMessage } from "@/lib/builder/presentation";

import React, { useMemo, useState, useEffect } from "react";
import {
  reviewedArtifactDecision,
  proposeArtifactMappings,
  type ArtifactMappingProposal,
} from "@/lib/aegis/artifact-mapping";
import {sourceRepositories} from "@/lib/collector/source-link";
import {artifactSourceKey,currentArtifactSources} from "@/lib/aegis/artifact-sources";
import { releaseProject } from "@/lib/aegis/control-rollup";
import type { PipelineEvidence } from "@/lib/aegis/pipeline-evidence";
import type { ArtifactMappingDecision } from "@/lib/aegis/types";

type Props = {
  record: PipelineEvidence;
  releases: PipelineEvidence[];
  controlIds: string[];
  catalogId?: "fedramp-rev5" | "fedramp-20x";
  controlTitles: Record<string, string>;
  decisions: ArtifactMappingDecision[];
  storageNote?: string | null;
  onDecision: (proposal: ArtifactMappingProposal, status: "accepted" | "rejected", controls?: string[], reviewer?: string, source?: PipelineEvidence) => Promise<void>;
};

export function ArtifactMappingProposals({
  record,
  releases,
  controlIds,
  catalogId = "fedramp-rev5",
  controlTitles,
  decisions,
  storageNote,
  onDecision,
}: Props) {
  const [reviewer, setReviewer] = useState("");
  const [chosen, setChosen] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const proposals = useMemo(() => {
    const prior = releases.filter(candidate =>
      releaseProject(candidate.pipelineUrl) === releaseProject(record.pipelineUrl)
      && Date.parse(candidate.createdAt) < Date.parse(record.createdAt),
    );
    const sources = record.schema === "aegis.evidence-event.v1" ? [...new Map([...releases, record].map(r=>[r.releaseSha256,r])).values()] : [record];
    const latest=currentArtifactSources(sources);
    return sources.flatMap(source => proposeArtifactMappings(source, controlIds, prior, catalogId).filter(p=>latest.get(artifactSourceKey(source,p.artifact))===source).map(p=>({...p, source})));
  }, [record, releases, controlIds, catalogId]);
  const repositories=useMemo(()=>sourceRepositories([...releases,record].flatMap(source=>source.collectedArtifacts ?? [])),[record,releases]);
  const [query,setQuery] = useState("");
  const filtered = proposals.filter(p=>`${p.artifact} ${p.source.collectedArtifacts?.find(a=>a.name===p.artifact)?.source.path ?? ""}`.toLowerCase().includes(query.toLowerCase()));
  const [page, setPage] = useState(0);
  const pageCount = Math.max(1, Math.ceil(filtered.length / 5));
  const proposalKeys = useMemo(()=>proposals.map(proposal => proposal.key).join("|"),[proposals]);
  useEffect(() => setPage(0), [proposalKeys,query]);
  const shown = filtered.slice(Math.min(page, pageCount - 1) * 5, Math.min(page, pageCount - 1) * 5 + 5);
  const pending = proposals.filter(proposal => !reviewedArtifactDecision(proposal.source, decisions, proposal)).length;

  async function decide(proposal: ArtifactMappingProposal & {source:PipelineEvidence}, status: "accepted" | "rejected") {
    setSaving(proposal.key);
    setError(null);
    try {
      await onDecision(proposal, status, [chosen[proposal.key] ?? proposal.candidates[0].controlId], reviewer, proposal.source);
    } catch (cause) {
      setError(requestMessage(cause,"Could not store the mapping decision."));
    } finally {
      setSaving(null);
    }
  }

  return <section className="release-card mapping-proposals" aria-label="Artifact mapping proposals" data-testid="mapping-proposals">
    <div className="release-section-title">
      <div><h2>Artifact mapping proposals</h2><p>Agent proposes · person approves</p></div>
      <span>{pending} pending</span>
    </div>
    <p className="release-note">Collected-file proposals cite exact facts and source lines. Historical pipeline leads use filenames, check ids and existing mappings in the selected profile. Accept adds evidence links only; it does not establish control satisfaction or authorization.</p>
    {storageNote && <p className="mapping-storage-note" role="status">{storageNote}</p>}
    {error && <p className="pipeline-error" role="alert">{error}</p>}
    <label className="rem-field"><span>Mapping reviewer</span><input aria-label="Mapping reviewer" value={reviewer} maxLength={200} onChange={e => setReviewer(e.target.value)} /></label>
    <label className="rem-field"><span>Find a file</span><input aria-label="Find a proposed file" value={query} onChange={e=>setQuery(e.target.value)} /></label>
    <div className="mapping-proposal-list">
      {shown.map(proposal => {
        const decision = reviewedArtifactDecision(proposal.source, decisions, proposal);
        const collected=proposal.source.collectedArtifacts?.find(a=>a.name===proposal.artifact);
        const candidateIds = proposal.candidates.map(candidate => candidate.controlId);
        return <article key={proposal.key} data-proposal-artifact={proposal.artifact} data-decision={decision?.status ?? "pending"}>
          <div className="mapping-proposal-summary">
            <div><span>{proposal.detection === "new" ? "New artifact" : "Unmapped artifact"}</span><strong>{proposal.source.collectedArtifacts?.find(a=>a.name===proposal.artifact)?.source.path ?? proposal.artifact}</strong></div>
            <span aria-label={`Candidate controls ${candidateIds.join(", ")}`}>{candidateIds.join(" · ")}</span>
          </div>
          {collected ? <p className="release-note"><SourceRepo source={collected.source}/></p> : repositories.length > 0 && <p className="release-note"><SystemSources sources={repositories}/></p>}
          <details>
            <summary>Why these controls?</summary>
            <div className="mapping-candidate-reasons">{proposal.candidates.map(candidate => <section key={candidate.controlId}>
              <strong>{candidate.controlId}{controlTitles[candidate.controlId] ? ` · ${controlTitles[candidate.controlId]}` : ""}</strong>
              <ul>{candidate.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul>
            </section>)}</div>
          </details>
          {!decision && <label className="rem-field"><span>Control to accept</span><select aria-label={`Control to accept for ${proposal.artifact}`} value={chosen[proposal.key] ?? proposal.candidates[0].controlId} onChange={e => setChosen({...chosen, [proposal.key]: e.target.value})}>{proposal.candidates.map(c => <option key={c.controlId}>{c.controlId}</option>)}</select></label>}
          {decision ? <p className={`mapping-decision ${decision.status}`}>
            {decision.status === "accepted"
              ? `Accepted by ${decision.reviewer || "a person"} · ${decision.controls.join(", ")} · ${decision.decidedAt} · applied to binder evidence links`
              : "Rejected by a person · not applied and will stay rejected"}
          </p> : <div className="mapping-proposal-actions">
            <button type="button" className="btn ghost" disabled={saving === proposal.key || !reviewer.trim()} onClick={() => void decide(proposal, "accepted")} aria-label={`Accept mapping for ${proposal.artifact}`}>Accept</button>
            <button type="button" className="btn ghost" disabled={saving === proposal.key} onClick={() => void decide(proposal, "rejected")} aria-label={`Reject mapping for ${proposal.artifact}`}>Reject</button>
          </div>}
        </article>;
      })}
    </div>
    {!shown.length && <p className="release-note">No unmapped artifact has a strong candidate from existing mappings.</p>}
    {pageCount > 1 && <nav aria-label="Mapping proposal pages" className="mapping-proposal-actions">
      <button type="button" className="btn ghost" disabled={page === 0} onClick={() => setPage(value => value - 1)}>Previous proposals</button>
      <span>Page {page + 1} of {pageCount}</span>
      <button type="button" className="btn ghost" disabled={page >= pageCount - 1} onClick={() => setPage(value => value + 1)}>Next proposals</button>
    </nav>}
  </section>;
}
