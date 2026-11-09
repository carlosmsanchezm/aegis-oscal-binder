import {artifactSourceKey,currentArtifactSources} from "./artifact-sources";
import {proposeArtifactMappings} from "./artifact-mapping";
import type {PipelineEvidence} from "./pipeline-evidence";
import type {PackageState} from "./types";

/** Proposals affect visibility, never links, findings, implementation or satisfaction. */
export function proposedCoverage(pkg: PackageState, releases: PipelineEvidence[]): PackageState {
  const byControl = new Map<string, {key:string;artifact:string; reasons:string[]; sourcePath?:string;source?:import("../collector/types").CollectedArtifact["source"]}[]>();
  const unique=[...new Map(releases.map(record=>[record.releaseSha256,record])).values()];
  const latest=currentArtifactSources(unique);
  const controlIds=pkg.controls.map(c=>c.id);
  for (const release of unique) for (const proposal of proposeArtifactMappings(release, controlIds, [], pkg.catalog.id ?? "fedramp-rev5")) {
    if(latest.get(artifactSourceKey(release,proposal.artifact))!==release)continue;
    const key=artifactSourceKey(release,proposal.artifact);
    const source = release.collectedArtifacts?.find(a=>a.name===proposal.artifact)?.source;
    const sourcePath = source?.path;
    for (const candidate of proposal.candidates) {
      const rows = byControl.get(candidate.controlId) ?? [];
      if (!rows.some(row=>row.key===key)) rows.push({key,artifact:proposal.artifact,reasons:candidate.reasons,...(sourcePath?{sourcePath,source}:{})});
      byControl.set(candidate.controlId,rows);
    }
  }
  const controls = pkg.controls.map(c=>({...c,proposedEvidence:byControl.get(c.id) ?? []}));
  return {...pkg,controls};
}
