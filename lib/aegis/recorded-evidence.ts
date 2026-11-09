import {CCM_EXAMPLE, gitlabArtifactUrl, pipelineArtifactNames, type PipelineEvidence} from './pipeline-evidence';
import {PODINFO_RETEST_RECEIPT} from './control-rollup';
/** Only these exact retained reference identities can open a recorded inspection page. */
export const RECORDED_EVIDENCE = [CCM_EXAMPLE, PODINFO_RETEST_RECEIPT];
export function recordedEvidenceHref(href: string, expected: PipelineEvidence): string | null {
  for (const record of RECORDED_EVIDENCE) {
    if (expected.pipelineUrl !== record.pipelineUrl || expected.commitSha !== record.commitSha || expected.releaseSha256 !== record.releaseSha256) continue;
    if (href === record.pipelineUrl) return `/evidence/recorded/${record.pipelineId}`;
    for (const name of pipelineArtifactNames(record)) {
      if (record.collectedArtifacts?.some(a=>a.name===name)) continue;
      if (href === gitlabArtifactUrl(record,name)) return `/evidence/recorded/${record.pipelineId}?${new URLSearchParams({artifact:name})}`;
    }
  }
  return null;
}
