import {factCandidates} from "../collector/mappings";
import relevance from "../../catalogs/artifact-relevance.json" with { type: "json" };
import { moderateControls } from "./moderate-baseline";
import { compareControlId } from "./control-order";
import {
  artifactFilename,
  controlsForArtifact,
  pipelineArtifactNames,
  type PipelineEvidence,
  type PipelineFamily,
} from "./pipeline-evidence";
import type { ArtifactMappingDecision, CatalogId, MappingProfile } from "./types";

export type MappingCandidate = {
  controlId: string;
  family: string;
  reasons: string[];
  coverageOnly?: boolean;
};

export type ArtifactMappingProposal = {
  profile: MappingProfile;
  key: string;
  artifact: string;
  detection: "new" | "unmapped";
  candidates: MappingCandidate[];
  similarArtifacts: string[];
};

export function artifactType(name: string): string {
  const lower = name.toLowerCase();
  return relevance.find(rule => rule.names.some(token => lower.includes(token)))?.type ?? "Other artifacts";
}

const GENERIC_TOKENS = new Set(["artifact", "evidence", "json", "raw", "report", "result", "results"]);

function tokens(value: string): string[] {
  return [...new Set(value.toLowerCase().split(/[^a-z0-9]+/).filter(token => token.length > 2 && !GENERIC_TOKENS.has(token)))];
}

function sharedTokens(left: string, right: string): string[] {
  const rightTokens = new Set(tokens(right));
  return tokens(left).filter(token => rightTokens.has(token));
}

export function pipelineReleaseKey(record: Pick<PipelineEvidence, "pipelineUrl" | "commitSha" | "releaseSha256">): string {
  return JSON.stringify([record.pipelineUrl, record.commitSha, record.releaseSha256]);
}

export function mappingProfile(controlIds: Iterable<string>, catalogId: CatalogId = "fedramp-rev5"): MappingProfile {
  return { catalogId, controlIds: [...new Set([...controlIds].map(id => id.trim().toUpperCase()))].sort(compareControlId) };
}

/** Evidence review belongs to the catalog, independent of the authored SSP layer. */
export function evidenceMappingProfile(catalogId: CatalogId, packageControlIds: Iterable<string>): MappingProfile {
  return mappingProfile(catalogId === "fedramp-rev5" ? moderateControls().map(control => control.id) : packageControlIds, catalogId);
}

export function sameMappingProfile(value: unknown, expected: MappingProfile): boolean {
  if (!value || typeof value !== "object") return false;
  const profile = value as MappingProfile;
  return profile.catalogId === expected.catalogId && Array.isArray(profile.controlIds)
    && profile.controlIds.length === expected.controlIds.length
    && profile.controlIds.every((id, i) => id === expected.controlIds[i]);
}

export function mappingProposalKey(record: PipelineEvidence, artifact: string, profile?: MappingProfile, candidates: string[] = []): string {
  const collected = record.collectedArtifacts?.find(a=>a.name===artifactFilename(artifact));
  return JSON.stringify([record.pipelineUrl, record.commitSha, record.releaseSha256, artifactFilename(artifact), profile ?? null, candidates, ...(collected ? [collected.sha256, collected.source.sha256] : [])]);
}

export function mappingDecision(
  record: PipelineEvidence,
  proposal: ArtifactMappingProposal,
  status: "accepted" | "rejected",
  decidedAt: string,
  controls = proposal.candidates.map(candidate => candidate.controlId),
  reviewer = "",
): ArtifactMappingDecision {
  return {
    profile: structuredClone(proposal.profile),
    proposalKey: proposal.key,
    releaseKey: pipelineReleaseKey(record),
    artifact: proposal.artifact,
    controls: [...new Set(controls)].sort(compareControlId),
    reviewer: reviewer.trim(),
    status,
    decidedAt,
  };
}

/**
 * Suggest mappings only from the selected profile's controls and mappings already
 * present in this release. Catalog/profile selection is supplied by the caller;
 * this heuristic contains no framework- or revision-specific relationship rules.
 */
export function proposeArtifactMappings(
  record: PipelineEvidence,
  allowedControlIds: Iterable<string>,
  priorReleases: PipelineEvidence[] = [],
  catalogId: CatalogId = "fedramp-rev5",
): ArtifactMappingProposal[] {
  const profile = mappingProfile(allowedControlIds, catalogId);
  const allowed = new Set(profile.controlIds);
  const priorArtifacts = new Set(priorReleases.flatMap(release => pipelineArtifactNames(release)));
  const mapped = record.families.flatMap(family =>
    family.evidence.map(name => ({ family, artifact: artifactFilename(name) })),
  );

  return pipelineArtifactNames(record)
    .flatMap(artifact => {
      const collected = record.collectedArtifacts?.find(a => a.name === artifact);
      if (collected) {
        const linked = new Set(controlsForArtifact(record, artifact));
        const candidates = factCandidates(collected, allowed, catalogId).filter(c => !linked.has(c.controlId));
        return candidates.length ? [{profile, key: mappingProposalKey(record, artifact, profile, candidates.map(c=>c.controlId)), artifact,
          detection: priorReleases.length && !priorArtifacts.has(artifact) ? "new" as const : "unmapped" as const, candidates, similarArtifacts: []}] : [];
      }
      const checkHints = record.checks
        .filter(check => sharedTokens(artifact, check.id).length > 0)
        .map(check => check.id);
      const similar = mapped
        .map(entry => ({ ...entry, shared: sharedTokens(artifact, entry.artifact) }))
        .filter(entry => entry.shared.length > 0);
      const byControl = new Map<string, MappingCandidate>();

      for (const entry of similar) {
        for (const controlId of entry.family.controls.map(id => id.toUpperCase()).filter(id => allowed.has(id))) {
          const existing = byControl.get(controlId) ?? {
            controlId,
            family: entry.family.family,
            reasons: [],
          };
          const shared = entry.shared.map(token => `"${token}"`).join(", ");
          existing.reasons.push(`Filename shares ${shared} with mapped ${entry.artifact}.`);
          existing.reasons.push(`Existing mapping links ${entry.artifact} to ${controlId}.`);
          existing.reasons.push(`${entry.family.family} family hint comes from that existing mapping.`);
          byControl.set(controlId, existing);
        }
      }

      const linked = new Set(controlsForArtifact(record, artifact));
      // Catalog titles provide relevance leads, never automatic coverage.
      const rules = relevance.filter(rule => rule.names.some(token => artifact.toLowerCase().includes(token)));
      for (const control of catalogId === "fedramp-rev5" ? moderateControls() : []) {
        if (!allowed.has(control.id) || control.enhancement || linked.has(control.id)) continue;
        const rule = rules.find(rule => rule.titles.some(title => title.toLowerCase() === control.title.toLowerCase()));
        if (!rule) continue;
        const candidate = byControl.get(control.id) ?? {controlId: control.id, family: control.family, reasons: []};
        candidate.reasons.push(`${rule.type} may support catalog objective “${control.title}”; review applicability before accepting.`);
        byControl.set(control.id, candidate);
      }
      for (const id of linked) byControl.delete(id);
      if (!byControl.size) return [];
      if (checkHints.length) {
        const reason = `Check id ${checkHints.map(id => `"${id}"`).join(", ")} matches the artifact name.`;
        for (const candidate of byControl.values()) candidate.reasons.unshift(reason);
      }
      const candidates = [...byControl.values()]
        .map(candidate => ({ ...candidate, reasons: [...new Set(candidate.reasons)] }))
        .sort((a, b) => compareControlId(a.controlId, b.controlId));
      return [{
        profile,
        key: mappingProposalKey(record, artifact, profile, candidates.map(candidate => candidate.controlId)),
        artifact,
        detection: priorReleases.length > 0 && !priorArtifacts.has(artifact) ? "new" as const : "unmapped" as const,
        candidates,
        similarArtifacts: [...new Set(similar.map(entry => entry.artifact))].sort(),
      }];
    })
    .sort((a, b) => Number(Boolean(record.collectedArtifacts?.some(c=>c.name===a.artifact))) - Number(Boolean(record.collectedArtifacts?.some(c=>c.name===b.artifact))) || b.candidates.length - a.candidates.length || a.artifact.localeCompare(b.artifact));
}

function decisionApplies(record: PipelineEvidence, decision: ArtifactMappingDecision): boolean {
  return decision.status === "accepted" && Boolean(decision.profile
    && restoreMappingDecision(decision, record, decision.profile.controlIds, decision.profile.catalogId));
}

/** Apply only recorded human acceptance. The source release remains immutable. */
export function applyAcceptedArtifactMappings(
  record: PipelineEvidence,
  decisions: ArtifactMappingDecision[],
): PipelineEvidence {
  const accepted = decisions.filter(decision => decisionApplies(record, decision));
  if (!accepted.length) return record;
  const additions: PipelineFamily[] = accepted.flatMap(decision => {
    const byFamily = new Map<string, string[]>();
    for (const controlId of decision.controls) {
      const family = controlId.split("-")[0] ?? "";
      if (!family) continue;
      byFamily.set(family, [...(byFamily.get(family) ?? []), controlId]);
    }
    return [...byFamily].map(([family, controls]) => ({
      family,
      controls: [...new Set(controls)].sort(compareControlId),
      coverage: `Person-approved mapping from ${decision.artifact}; evidence link only. This does not establish control satisfaction or authorization.`,
      evidence: [decision.artifact],
    }));
  });
  return { ...record, families: [...record.families, ...additions] };
}

export function decisionForProposal(
  decisions: ArtifactMappingDecision[],
  proposal: Pick<ArtifactMappingProposal, "key">,
): ArtifactMappingDecision | null {
  return decisions.find(decision => decision.proposalKey === proposal.key) ?? null;
}

/** Show an earlier, narrower acceptance without expanding the controls approved. */
export function reviewedArtifactDecision(record: PipelineEvidence, decisions: ArtifactMappingDecision[], proposal: ArtifactMappingProposal): ArtifactMappingDecision | null {
  const exact = decisionForProposal(decisions, proposal);
  if (exact) return exact;
  return decisions.find(decision => decision.status === "accepted"
    && decision.artifact === proposal.artifact && decision.profile?.catalogId === proposal.profile.catalogId
    && Array.isArray(decision.controls) && Array.isArray(decision.profile.controlIds)
    && decision.controls.every(id => proposal.profile.controlIds.includes(id))
    && restoreMappingDecision(decision, record, decision.profile.controlIds, decision.profile.catalogId)) ?? null;
}


/** Cached approvals cannot gain controls when a profile or proposal changes. */
export function restoreMappingDecision(value: unknown, record: PipelineEvidence, controlIds: Iterable<string>, catalogId: CatalogId = "fedramp-rev5"): ArtifactMappingDecision | null {
  if (!value || typeof value !== "object") return null;
  const decision = value as ArtifactMappingDecision;
  if ((decision.status !== "accepted" && decision.status !== "rejected") || !Number.isFinite(Date.parse(decision.decidedAt)) || decision.releaseKey !== pipelineReleaseKey(record)) return null;
  const proposal = proposeArtifactMappings(record, controlIds, [], catalogId).find(item => item.key === decision.proposalKey);
  if (!proposal || decision.artifact !== proposal.artifact || !sameMappingProfile(decision.profile, proposal.profile)
    || !Array.isArray(decision.controls) || !decision.controls.length
    || new Set(decision.controls).size !== decision.controls.length
    || decision.controls.some(id => !proposal.candidates.some(candidate => candidate.controlId === id))
    || (decision.reviewer !== undefined && (typeof decision.reviewer !== "string" || decision.reviewer.length > 200))) return null;
  return mappingDecision(record, proposal, decision.status, decision.decidedAt, decision.controls, decision.reviewer);
}
