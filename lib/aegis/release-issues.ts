import {scannerRetestDiff} from "../collector/retest-diff";
import {gateIssueState} from "./gate-issue-state";
import type { PipelineEvidence } from "./pipeline-evidence";
import type { PlanProposal } from "./plan-proposal";
import type { ReviewObservation } from "./review-context";
export type IssueState = "plan" | "noplan" | "fixed" | "unrev";
export type ReleaseIssue = { id: string; state: IssueState; what: string; file: string; count: number; button: string; planId?: string; observation?: ReviewObservation; checkId?: string; source?:PipelineEvidence };
const LABEL: Record<string,string> = { sast:"code", dependencies:"dependency", image:"image", configuration:"configuration", secrets:"secret" };
export function releaseIssues(record: PipelineEvidence, plans: PlanProposal[], releases:PipelineEvidence[] = []) {
  const groups = new Map<string, ReleaseIssue[]>(), itemized = new Map<string,number>();
  const add = (control: string, issue: ReleaseIssue) => groups.set(control, [...(groups.get(control) ?? []), issue]);
  const observations=(record.reviewItems??[]).map(observation=>({observation,source:record}));
  const seen=new Set(observations.map(o=>o.observation.id));
  for(const source of releases)for(const observation of source.reviewItems??[]){if(!observation.id.startsWith("scan-")||seen.has(observation.id))continue;if(!scannerRetestDiff(source,record).comparable)continue;seen.add(observation.id);observations.push({observation,source});}
  const retestStates=new Map<PipelineEvidence,ReturnType<typeof scannerRetestDiff>>();
  const latestRetest=(source:PipelineEvidence)=>{
    if(!retestStates.has(source)){
      const latest=[record,...releases].filter(candidate=>scannerRetestDiff(source,candidate).comparable).sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt))[0];
      retestStates.set(source,scannerRetestDiff(source,latest??source));
    }
    return retestStates.get(source)!;
  };
  for (const {observation,source} of observations) {
    const scope = observation.scope, control = scope?.controls[0] ?? "Unmapped", artifacts = scope?.artifacts ?? [];
    const check = source.checks.find(c => artifacts.includes(c.artifact));
    const candidates = plans.filter(p => p.id.endsWith(":" + observation.id));
    const plan = candidates.find(p => p.sourceReleaseId === record.pipelineId) ?? candidates[0];
    const measuredFixed=latestRetest(source).fixed.includes(observation.id);
    const gated=observation.id.startsWith("scan-")&&plan ? gateIssueState(plan.workflowState??"planned") : plan;
    const state: IssueState | null = gated?.closureConfirmed ? null : measuredFixed || gated?.readyToClose ? "fixed" : plan ? "plan" : "noplan";
    const ids = [...new Set(observation.description.match(/KSV-\d{4}/g) ?? [])];
    for (const id of ids.length ? ids : [scope?.title ?? observation.id]) {
      const detail = observation.description.match(new RegExp(id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\(([^)]+)\\)"));
      if (state) add(control,{ id, state, what: detail ? "Runs with " + detail[1].replace(/≤/, "≤ ").replace(/\s+/g," ") + "." : scope?.title ?? "", file: check?.artifact ?? artifacts[0] ?? "", count: 1, button: state === "fixed" ? plan ? "Confirm closure" : "Triage" : state === "plan" ? "Review plan" : "Draft plan", planId: plan?.id, observation, source, checkId: check?.id });
      if (check && source === record) itemized.set(check.id,(itemized.get(check.id) ?? 0) + 1);
    }
    for (const remaining of scope?.remainingScope.filter(x => /finding/i.test(x)) ?? []) {
      add(control,{ id: remaining.replace(/[-\s]*finding$/i, "").replace(/-/g," "), state:"noplan", what:`Named as remaining scope of “${scope?.title ?? observation.id}”.`, file:check?.artifact ?? artifacts[0] ?? "", count:1, button:"Draft plan", observation, checkId: check?.id });
      if (check && source === record) itemized.set(check.id,(itemized.get(check.id) ?? 0) + 1);
    }
  }
  for (const check of record.checks) {
    const rest = (check.findings ?? 0) - (itemized.get(check.id) ?? 0); if (rest <= 0) continue;
    const control = record.families.find(f => f.evidence.includes(check.id))?.controls[0] ?? "Unmapped";
    add(control,{ id:`${rest} ${LABEL[check.id] ?? check.id} findings`, count:rest, state:"unrev", what:record.collectedArtifacts?.some(a=>a.name===check.artifact) ? "Counted by the scan. Individual details are limited to the retained safe finding inventory." : `Counted by the scan. Binder has not read ${check.artifact} yet, so they are not listed one by one.`, file:check.artifact, button:"Triage", checkId:check.id });
  }
  const all = [...groups.values()].flat();
  return { groups: [...groups].map(([control, issues]) => ({ control, issues, open: issues.filter(i => i.state !== "fixed").reduce((n,i) => n+i.count,0) })), count: (state:IssueState) => all.filter(i => i.state === state).reduce((n,i) => n+i.count,0), total: record.findingCount, empty: all.length === 0 };
}
