import {mergeStoredReleases as mergeHistory} from "../../lib/aegis/control-rollup";
import {RECORDED_EVIDENCE} from "../../lib/aegis/recorded-evidence";
import {CCM_EXAMPLE,type PipelineEvidence} from "../../lib/aegis/pipeline-evidence";
/** Tests explicitly supply the retained reference dataset they exercise. */
export function referenceHistory(received: PipelineEvidence[] = [], sourceUrl = CCM_EXAMPLE.pipelineUrl) {
  return mergeHistory([...RECORDED_EVIDENCE,...received],sourceUrl);
}

import {proposePlans} from "../../lib/aegis/plan-proposal";
export function referenceProposals(received: PipelineEvidence[] = []) {
  return proposePlans(referenceHistory(received,received[0]?.pipelineUrl ?? CCM_EXAMPLE.pipelineUrl));
}
