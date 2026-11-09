import { readConnection } from "../server/builder-store";
import { connectionRecords } from "./service";
import { connectionProposals, proposalKey, reviewVersion } from "./approvals";
import { evidenceSource } from "../aegis/evidence-source";
import { readRemediation } from "../aegis/remediation-store";
import { itemSource } from "../aegis/item-source";
export async function findingItems(
  connectionId: string,
  sessionId: string,
  origin: string,
  filter?: string,
) {
  const connection = await readConnection(connectionId);
  if (!connection) throw new Error("Connection unavailable.");
  const releases = await connectionRecords({
      connectionId,
      ownerHash: connection.ownerHash,
    }),
    rows = await connectionProposals(connectionId, sessionId, origin),
    record = (await readRemediation(sessionId))?.records.find(
      (r) => r.key === proposalKey(connectionId),
    );
  const triage = (record?.issueTriage ?? []).map((v) => {
    const t = v as import("../aegis/issue-actions").IssueTriage;
    return { ...t, source_label: itemSource(t.source_label) };
  });
  const poam_items = rows.map(({ proposal, review }) => ({
    ...proposal,
    pullRequest: record?.pullRequests?.findLast(l => l.poamItemId === proposal.id),
    review_version: reviewVersion(proposal),
    source_label: itemSource(proposal.source_label),
    review,
  }));
  const findings = (
    await Promise.all(
      releases.map(async (r) => {
        const source_label = await evidenceSource(
          sessionId,
          connectionId,
          r.releaseSha256,
        );
        return (r.reviewItems ?? []).map((i) => ({
          ...i,
          receipt_id: r.releaseSha256,
          source_label,
          poam_items: poam_items.filter(
            (p) =>
              p.id.endsWith(":" + i.id) && p.sourceReleaseId === r.pipelineId,
          ),
          triage_proposals: triage.filter(
            (t) => t.issueId === i.id && t.receiptId === r.releaseSha256,
          ),
        }));
      }),
    )
  )
    .flat()
    .filter(
      (i) =>
        !filter || i.id === filter || i.poam_items.some((p) => p.id === filter),
    );
  return {
    findings,
    poam_items: poam_items.filter(
      (p) => !filter || p.id === filter || p.id.endsWith(":" + filter),
    ),
  };
}
