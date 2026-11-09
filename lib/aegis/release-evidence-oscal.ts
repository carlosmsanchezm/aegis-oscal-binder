import { REMEDIATION_NAMESPACE, stableUuid } from "./poam";
import { releaseFixedControls, type ReleaseEvidence, type ReleaseItem } from "./release-evidence";
type Document = Record<string, any>;
const prop = (name: string, value: string) => ({name, value, ns: REMEDIATION_NAMESPACE});
export const releaseObservationId = (bundle: ReleaseEvidence, item: ReleaseItem) =>
  stableUuid("release-item:" + bundle.releaseSha256 + ":" + item.poamItemId + ":" + item.mergeSha);

/** Enrich the existing three OSCAL models. Never changes risk status or human decisions. */
export function addReleaseEvidence(document: Document, bundles: ReleaseEvidence[], planId?: string): Document {
  const kind = Object.keys(document).find(key => ["assessment-results", "plan-of-action-and-milestones", "system-security-plan"].includes(key));
  if (!kind || !bundles.length) return document;
  const body = document[kind];
  const resources: Document[] = body["back-matter"]?.resources ?? [];
  body["back-matter"] = {...body["back-matter"], resources};
  const addResource = (href: string, title: string, props: Document[], identity = href) => {
    const uuid = stableUuid("release-resource:" + identity);
    if (!resources.some(r => r.uuid === uuid)) resources.push({uuid, title, props, rlinks: [{href}]});
    return uuid;
  };
  const latest = new Map([...bundles].sort((a,b) => Date.parse(a.collectedAt) - Date.parse(b.collectedAt)).map(bundle => [bundle.connectionId, bundle.releaseSha256]));
  for (const bundle of bundles) {
    const releaseUuid = addResource(bundle.releaseUrl, "Collected release " + bundle.releaseId, [
      prop("release-id", bundle.releaseId), prop("release-commit", bundle.commitSha),
      prop("evidence-event-sha256", bundle.releaseSha256), prop("previous-commit", bundle.previousCommitSha || "first-release"),
      ...bundle.items.filter(i => i.retestResult === "pass").map(i => prop("observation-uuid", releaseObservationId(bundle, i))),
    ], bundle.releaseSha256);
    for (const item of bundle.items) {
      const prUuid = addResource(item.prUrl, "Pull request " + item.prNumber, [prop("merge-sha", item.mergeSha)]);
      const ciUuids = item.ciRuns.map(run => addResource(run.url, "CI run " + run.id, [prop("ci-run-id", run.id), prop("merge-sha", item.mergeSha)]));
      const props = [
        prop("poam-item-id", item.poamItemId), prop("control-id", item.controlId || "unmapped"),
        prop("finding-id", item.findingId), prop("pr-number", String(item.prNumber)),
        prop("merge-sha", item.mergeSha), ...(item.ciRunId ? [prop("ci-run-id", item.ciRunId)] : []),
        prop("retest-verdict", item.retestResult), prop("corrective-release", bundle.releaseId),
        prop("corrective-release-commit", bundle.commitSha),
        ...(item.retestReceiptId ? [prop("retest-receipt-sha256", item.retestReceiptId)] : []),
      ];
      const links = [prUuid, ...ciUuids, releaseUuid].map(uuid => ({href: "#" + uuid, rel: "reference"}));
      const uuid = releaseObservationId(bundle, item);
      const observation = {uuid, title: "Release retest: " + item.findingId,
        description: "Collected scanner result for this item: " + item.retestResult + ". Human closure remains separate.",
        methods: ["TEST"], collected: bundle.collectedAt, props, "relevant-evidence": links.map(link => ({href: link.href, description: "Retained PR, CI or release evidence"}))};
      if (kind === "assessment-results") {
        const result = body.results?.[0];
        if (result) {result.observations ??= []; if (!result.observations.some((o: Document) => o.uuid === uuid)) result.observations.push(observation);}
      } else if (kind === "plan-of-action-and-milestones") {
        body.observations ??= [];
        if (!body.observations.some((o: Document) => o.uuid === uuid)) body.observations.push(observation);
        for (const poam of body["poam-items"] ?? []) {
          const saved = poam.props?.find((p: Document) => p.name === "plain-plan-record")?.remarks;
          let id = planId;
          if (saved) {try {id = JSON.parse(saved).id;} catch {id = undefined;}}
          if (id !== item.poamItemId) continue;
          poam.props = [...(poam.props ?? []), ...props];
          poam.links = [...(poam.links ?? []), ...links];
          poam["related-observations"] = [...(poam["related-observations"] ?? []), {"observation-uuid": uuid}];
        }
      }
    }
    if (kind === "system-security-plan" && latest.get(bundle.connectionId) === bundle.releaseSha256) for (const requirement of body["control-implementation"]?.["implemented-requirements"] ?? []) {
      const fixed = releaseFixedControls(bundle);
      const id = String(requirement["control-id"]).toUpperCase();
      if (!fixed.has(id)) continue;
      requirement.links = [...(requirement.links ?? []), {href: "#" + releaseUuid, rel: "reference", text: "Collected release retest; human closure separate"}];
      requirement.props = [...(requirement.props ?? []), ...bundle.items.filter(i => i.controlId === id && i.retestResult === "pass")
        .map(item => prop("release-observation-uuid", releaseObservationId(bundle, item)))];
    }
  }
  return document;
}
