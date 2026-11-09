import {sourceRepositories} from "../collector/source-link";
import {proposedCoverage} from "./proposed-coverage";
import { rollupControlResults, type ProvenResult } from "./control-rollup";
import { MODERATE_BASELINE_COUNT, MODERATE_PROFILE_VERSION } from "./moderate-baseline";
import { artifactFilename, gitlabArtifactUrl, type PipelineEvidence } from "./pipeline-evidence";
import type { ControlView, EvidenceView, FamilyView, PackageState } from "./types";

import {releaseSystemName} from "./system-name";
export {releaseSystemName} from "./system-name";

function evidenceFor(result: ProvenResult, releases: PipelineEvidence[], systemSources:EvidenceView["systemSources"]): EvidenceView[] {
  const record = releases.find(r => r.pipelineUrl === result.releaseUrl && r.releaseSha256 === result.releaseSha256);
  return result.evidence.map((name) => {
    const file = artifactFilename(name);
    const source=record?.collectedArtifacts?.find(artifact=>artifact.name===file)?.source;
    const href = gitlabArtifactUrl(record ?? {pipelineUrl:result.releaseUrl,artifactJobId:result.artifactJobId,releaseSha256:result.releaseSha256,artifacts:result.evidence} as PipelineEvidence,file) ?? "";
    return {
      id: `${result.releaseId}:${result.artifactJobId}:${result.releaseSha256}:${file}`,
      displayId: `Release #${result.releaseId}`,
      title: file,
      ...(source ? {source} : systemSources?.length ? {systemSources} : {}),
      type: "Document",
      href,
      uuid: `${result.releaseId}:${result.artifactJobId}:${result.releaseSha256}:${file}`,
      valid: true,
      errors: [],
      fileStatus: href ? "link" : "name",
    };
  });
}

function viewFor(row: ReturnType<typeof rollupControlResults>[number], prior: ControlView | undefined, releases: PipelineEvidence[],systemSources:EvidenceView["systemSources"]): ControlView {
  const result = row.result;
  const evidence = result && result.mappingStatus !== "proposed" ? evidenceFor(result, releases, systemSources) : [];
  return {
    id: row.id,
    oscalId: row.oscalId,
    title: row.title,
    family: row.family,
    implementation: result ? [result.finding, result.coverage].filter(Boolean).join(" ") : "",
    responsibleRoleId: prior?.responsibleRoleId ?? "",
    responsibleRole: prior?.responsibleRole ?? "",
    responsibleRoleIds: prior?.responsibleRoleIds ?? [],
    roleLabels: prior?.roleLabels ?? [],
    ...(prior?.providerCoverage?{providerCoverage:prior.providerCoverage}:{}),
    ...(prior?.implementedBy?{implementedBy:prior.implementedBy}:{}),
    itemStatements: [],
    evidence,
    validEvidenceCount: evidence.length,
    missing: [],
    complete: false,
    rollupState: result && result.mappingStatus !== "proposed" ? "recorded" : "blank",
    rollupReleaseId: result?.releaseId ?? "",
  };
}

/**
 * Package map, level 2, and the package inventory read this projection.
 * The control list is the Moderate baseline. The current result is the release rollup.
 * A loaded SSP can still supply responsible roles. It does not supply a second control list,
 * a pass, or evidence that replaces the newer stored result.
 */
export function applyReleaseRollup(shell: PackageState, releases: PipelineEvidence[], loaded: PackageState | null = null): PackageState {
  const prior = new Map((loaded?.controls ?? []).map((control) => [control.id, control]));
  const systemSources=sourceRepositories(releases.flatMap(record=>record.collectedArtifacts ?? []));
  const controls = rollupControlResults(releases).map((row) => viewFor(row, prior.get(row.id), releases,systemSources));
  const recorded = controls.filter((control) => control.rollupState === "recorded");
  const blank = controls.length - recorded.length;
  const families: FamilyView[] = shell.map.families.map((family) => {
    const members = controls.filter((control) => control.family === family.id);
    const count = members.filter((control) => control.rollupState === "recorded").length;
    const summary = count === 0 ? "Blank" : `${count} recorded`;
    return { id: family.id, total: members.length, open: 0, label: summary, summary };
  });
  return proposedCoverage({
    ...shell,
    loaded: true,
    workspaceName: releaseSystemName(releases),
    boundaryId: null,
    sourceFilename: null,
    sourceProfileHref: null,
    catalogPin: MODERATE_PROFILE_VERSION,
    catalog: {
      ...shell.catalog,
      id: "fedramp-rev5",
      label: shell.catalog.label || "FedRAMP Rev5",
      pin: MODERATE_PROFILE_VERSION,
      status: "live",
      bound: true,
      note: "FedRAMP Rev 5 Moderate baseline list. Membership is not a pass or an authorization.",
    },
    controls,
    families,
    inScopeCount: controls.length,
    gate: {
      status: "FAIL",
      incomplete: blank,
      complete: 0,
      total: controls.length,
      label: `${recorded.length} recorded · ${blank} blank`,
      failClosed: true,
      incompleteControlIds: controls.filter((control) => control.rollupState === "blank").map((control) => control.id),
    },
  }, releases);
}

export function rollupPackageCounts(pkg: PackageState): { total: number; recorded: number; blank: number } {
  const recorded = pkg.controls.filter((control) => control.rollupState === "recorded").length;
  return { total: pkg.controls.length, recorded, blank: pkg.controls.length - recorded };
}

export const ROLLUP_BASELINE_COUNT = MODERATE_BASELINE_COUNT;
