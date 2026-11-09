import type { SystemObservationEvidence } from "../../aegis/pipeline-evidence";
import { scannerFindingId } from "../derive-review-items";
import { scannerRetestDiff } from "../retest-diff";
import { AWS_DEPLOYMENT_PRODUCER, AWS_IAC_CRITERIA, type DeploymentCriterion } from "./deployment-criteria";

/** Review readiness only: a real, complete Checkov head scan resolves the corresponding
 * rule at the exact IaC paths. This function never proves deployed AWS remediation. */
export function awsIaCHeadProof(before: SystemObservationEvidence, issueId: string, releases: SystemObservationEvidence[], head: string) {
  if (before.observation.producer !== AWS_DEPLOYMENT_PRODUCER) return null;
  const issue = before.reviewItems?.find(i=>i.id===issueId);
  const criterion = issue?.scope.title as DeploymentCriterion;
  const rule = AWS_IAC_CRITERIA[criterion];
  const paths = issue?.scope.fixPaths;
  if (!rule || !paths?.length) return null;
  const native = releases.filter(r=>r.observation.producer==="GitHub Actions" && r.observation.subject.id===before.observation.subject.id);
  const baseline = native.find(r=>r.commitSha===before.commitSha);
  const retest = native.filter(r=>r.commitSha===head).at(-1);
  if (!baseline || !retest || !scannerRetestDiff(baseline,retest).comparable) return null;
  const fixed = scannerRetestDiff(baseline,retest).fixed;
  for (const path of paths) {
    const matches=(baseline.collectedArtifacts??[]).flatMap(artifact=>artifact.facts
      .filter(f=>f.outcome==="fail"&&f.field===`finding.${rule}/${path}`&&f.fixPaths?.includes(path))
      .map(f=>scannerFindingId(artifact.source.path,f.field)));
    if (!matches.length || !matches.every(id=>fixed.includes(id))) return null;
  }
  return retest;
}
