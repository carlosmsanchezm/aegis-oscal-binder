import { readLog, readObject, writeObjectOnce } from "../immutable-log";
import { storageKey } from "../storage-key";
import { trustedReleases } from "../collector/trusted-release";
import { scannerRetestDiff } from "../collector/retest-diff";
export type RetestRequest = {
  id: string;
  at: string;
  tokenId: string;
  issueId: string;
  sourceReceipt: string;
  sourceWorkflow: string;
  state: string;
};
const requestPrefix = (connectionId: string) =>
  storageKey(["retest-requests", connectionId]) + "/";
const satisfactionKey = (connectionId: string, id: string) =>
  storageKey(["retest-satisfaction", connectionId, id + ".json"]);
type Satisfaction = {
  state: "satisfied-by-collection";
  receiptId: string;
  runId: string;
  at: string;
  outcome: "fixed" | "remaining" | "unverified";
};
export async function satisfyCollectedRetests(
  sessionId: string,
  connectionId: string,
) {
  const releases = await trustedReleases(sessionId, connectionId);
  for (const request of await readLog<RetestRequest>(
    requestPrefix(connectionId),
  )) {
    const before = releases.find(
      (r) => r.releaseSha256 === request.body.sourceReceipt,
    );
    if (!before) continue;
    const link = (await (await import("../github/pull-requests")).pullRequestLinks(sessionId, connectionId)).findLast(l => l.findingId === request.body.issueId && l.sourceReleaseId === before.pipelineId);
    const {ciGreenFor} = await import("../github/pr-types");
    if (link && (link.state !== "merged" || !link.mergedCommitSha || !ciGreenFor(link, link.mergedCommitSha))) continue;
    const releaseBinding = link ? await (await import("../server/release-evidence")).releaseClosureBinding(sessionId, connectionId, link) : null;
    if (releaseBinding && !releaseBinding.verified) continue;
    const boundId = link ? `${request.body.id}-${link.prNumber}-${link.mergedCommitSha}` : request.body.id;
    if (await readObject(satisfactionKey(connectionId, boundId))) continue;
    const after = [...releases].reverse().find(
      (r) =>
        (!link || r.commitSha === (releaseBinding?.commit ?? link.mergedCommitSha)) && (!releaseBinding || r.releaseSha256 === releaseBinding.receipt) && scannerRetestDiff(before, r, link ? Date.now() : Date.parse(r.createdAt) + 1).comparable,
    );
    if (!after) continue;
    const diff = scannerRetestDiff(
      before,
      after,
      link ? Date.now() : Date.parse(after.createdAt) + 1,
    );
    const satisfied: Satisfaction = {
      state: "satisfied-by-collection",
      receiptId: after.releaseSha256,
      runId: after.artifactJobId,
      at: new Date().toISOString(),
      outcome: diff.fixed.includes(request.body.issueId)
        ? "fixed"
        : diff.remaining.includes(request.body.issueId)
          ? "remaining"
          : "unverified",
    };
    const key = satisfactionKey(connectionId, boundId);
    try {
      await writeObjectOnce(key, satisfied);
    } catch (e) {
      if (!(await readObject(key))) throw e;
    }
  }
}
export async function retestRequests(connectionId: string, sessionId?: string) {
  const links = sessionId ? await (await import("../github/pull-requests")).pullRequestLinks(sessionId, connectionId) : [];
  const releases = sessionId ? await trustedReleases(sessionId, connectionId) : [];
  return Promise.all(
    (await readLog<RetestRequest>(requestPrefix(connectionId))).map(
      async (row) => {
        const source = releases.find(r => r.releaseSha256 === row.body.sourceReceipt);
        const link = links.findLast(l => l.findingId === row.body.issueId && l.sourceReleaseId === source?.pipelineId);
        const {ciGreenFor} = await import("../github/pr-types");
        const releaseBinding = link && sessionId ? await (await import("../server/release-evidence")).releaseClosureBinding(sessionId, connectionId, link) : null;
        const valid = (!releaseBinding || releaseBinding.verified) && (!link || (link.state === "merged" && !!link.mergedCommitSha && ciGreenFor(link, link.mergedCommitSha)));
        return {...row.body, satisfaction: valid ? await readObject<Satisfaction>(satisfactionKey(connectionId, link ? `${row.body.id}-${link.prNumber}-${link.mergedCommitSha}` : row.body.id)) : null};
      },
    ),
  );
}
