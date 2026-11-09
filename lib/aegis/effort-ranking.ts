import { decisionPlan } from "./remediation-rollup";
import { compareControlId } from "./control-order";
import type { ControlRollupRow } from "./control-rollup";
import type { RemediationPlan } from "./remediation";
import type { MapDirectedEdge } from "./types";

export type EffortRecommendation = {
  id: string;
  controlId: string;
  title: string;
  kind: "open-finding" | "blank";
  score: number;
  risk: number;
  riskReason: string;
  relevanceReason: string;
  costReason: string;
  artifactNames: string[];
  relatedControlIds: string[];
  planStatus: "none" | "open" | "engineering-complete" | "validated" | "ready-for-review";
};

type RankEffortInput = {
  rows: ControlRollupRow[];
  relationships: MapDirectedEdge[];
  plans?: RemediationPlan[];
  postureLabel: string;
  riskRatings?: Record<string, number>;
};

function planStatus(plan: RemediationPlan | undefined): EffortRecommendation["planStatus"] {
  if (!plan) return "none";
  if (plan.readyForReview) return "ready-for-review";
  if (plan.validationRecorded) return "validated";
  if (plan.engineeringComplete) return "engineering-complete";
  return "open";
}

function planBoost(status: EffortRecommendation["planStatus"]): number {
  return { none: 0, open: 80, "engineering-complete": 160, validated: 240, "ready-for-review": 320 }[status];
}

function planCostReason(status: EffortRecommendation["planStatus"]): string | null {
  if (status === "ready-for-review") return "An internal plan is already prepared for closure review; the external decision still belongs to a person.";
  if (status === "validated") return "The internal plan already contains recorded validation, so the next work is review rather than new collection.";
  if (status === "engineering-complete") return "Engineering completion is recorded in the internal plan; independent review remains.";
  if (status === "open") return "An open internal plan already preserves the scope and proposed work, reducing rediscovery.";
  return null;
}

/**
 * Rank review work from selected-profile rows, catalog relationships, evidence mappings,
 * and existing internal plans. Relationships are only an inspection lead; this function
 * never creates an evidence mapping or a satisfaction decision.
 */
export function rankEffortNext({ rows, relationships, plans = [], postureLabel, riskRatings = {} }: RankEffortInput): EffortRecommendation[] {
  const byId = new Map(rows.map(row => [row.id, row]));
  const planByControl = new Map<string, RemediationPlan>();
  const lastActivity = (plan: RemediationPlan) => plan.history.reduce((at, entry) => entry.at > at ? entry.at : at, plan.createdAt);
  for (const row of rows) {
    const matching = plans.flatMap(plan => {
      const decision = decisionPlan(plan, row);
      return decision ? [decision] : [];
    }).sort((a, b) => lastActivity(b).localeCompare(lastActivity(a)) || b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
    if (matching[0]) planByControl.set(row.id, matching[0]);
  }

  const related = new Map<string, Set<string>>();
  const addRelated = (from: string, to: string) => {
    const controls = related.get(from) ?? new Set<string>();
    controls.add(to);
    related.set(from, controls);
  };
  for (const edge of relationships) {
    if (!byId.has(edge.fromId) || !byId.has(edge.toId)) continue;
    addRelated(edge.fromId, edge.toId);
    addRelated(edge.toId, edge.fromId);
  }

  const recommendations: EffortRecommendation[] = [];
  for (const row of rows) {
    const plan = planByControl.get(row.id);
    const status = planStatus(plan);
    const planReason = planCostReason(status);
    if (row.result?.finding && !plan?.closure.recorded) {
      const artifacts = [...new Set([
        ...row.result.sourceArtifacts.map(item => item.name),
        ...row.result.evidence,
      ])].sort();
      const measured = row.result.checks;
      const measuredReady = measured.length > 0 && measured.every(check => check.verdict === "pass" && (!check.evidenceState || check.evidenceState === "pass"));
      recommendations.push({
        id: `finding:${row.id}`,
        controlId: row.id,
        title: row.title,
        kind: "open-finding",
        risk: riskRatings[row.id] ?? 1,
        score: 10_000 + planBoost(status) + artifacts.length * 8 + (measuredReady ? 180 : 0),
        riskReason: `A stored release retains a scoped finding for ${row.id}; a scanner result is a risk signal, not an approval decision.`,
        relevanceReason: artifacts.length
          ? `${artifacts.length} pipeline artifact${artifacts.length === 1 ? "" : "s"} already support the finding scope: ${artifacts.slice(0, 3).join(", ")}${artifacts.length > 3 ? "…" : ""}.`
          : "The finding is stored, but no supported producing-job artifact is currently linked to its scope.",
        costReason: measured.some(check => check.evidenceState === "stale")
          ? "The retained retest expired; collect fresh measurements before closure review."
          : planReason ?? (measuredReady
          ? `${measured.length} measured retest result${measured.length === 1 ? " is" : "s are"} already stored; a person still decides the next action.`
          : "The finding already has a named control and review scope, so it is cheaper to investigate than an unscoped blank."),
        artifactNames: artifacts,
        relatedControlIds: [],
        planStatus: status,
      });
      continue;
    }
    if (row.result) continue;

    const linkedNeighbors = [...(related.get(row.id) ?? [])]
      .map(id => byId.get(id))
      .filter((candidate): candidate is ControlRollupRow => Boolean(candidate?.result));
    const artifacts = [...new Set(linkedNeighbors.flatMap(candidate => candidate.result?.evidence ?? []))].sort();
    const relatedIds = linkedNeighbors.map(candidate => candidate.id).sort(compareControlId);
    const sameFamily = linkedNeighbors.filter(candidate => candidate.family === row.family).length;
    recommendations.push({
      id: `blank:${row.id}`,
      controlId: row.id,
      title: row.title,
      kind: "blank",
      risk: riskRatings[row.id] ?? 0,
      score: (row.enhancement ? 1_000 : 2_000)
        + (sameFamily ? 200 + Math.min(sameFamily, 2) * 10 : 0)
        + (relatedIds.length ? 80 + Math.min(relatedIds.length, 3) * 5 : 0)
        + Math.min(artifacts.length, 3) * 5
        + planBoost(status),
      riskReason: `${postureLabel} ${row.enhancement ? "required enhancement" : "base control"} ${row.id} has no linked evidence. Blank does not mean noncompliant.`,
      relevanceReason: relatedIds.length
        ? `Existing pipeline evidence is linked to catalog-related controls ${relatedIds.slice(0, 4).join(", ")}${relatedIds.length > 4 ? "…" : ""}; that relationship is an inspection lead, not a mapping.`
        : "No existing pipeline evidence is linked to a catalog-related control, so there is no cheap relevance signal yet.",
      costReason: planReason ?? (artifacts.length
        ? `Inspect ${artifacts.slice(0, 3).join(", ")}${artifacts.length > 3 ? "…" : ""} first because the pipeline already produces ${artifacts.length === 1 ? "it" : "them"} for related controls.`
        : "This likely needs new evidence or analysis, so it ranks below evidence-adjacent blanks."),
      artifactNames: artifacts,
      relatedControlIds: relatedIds,
      planStatus: status,
    });
  }

  return recommendations.sort((a, b) =>
    b.risk - a.risk || b.score - a.score
    || (a.kind === b.kind ? 0 : a.kind === "open-finding" ? -1 : 1)
    || compareControlId(a.controlId, b.controlId),
  );
}
