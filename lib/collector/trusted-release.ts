import { storageKey } from "../storage-key";
import { objectKeys, readObject, writeObjectOnce } from "../immutable-log";
import {
  retainEvent,
  readBundle,
  readConnection,
} from "../server/builder-store";
import { summarizeBuilderBundle } from "../server/builder-observation";
import { connectedReleases } from "../aegis/connected-evidence";
import { readGithubRelease, collectGithubRelease } from "./github-release";
import type { Octokit } from "@octokit/rest";
import type { EvidenceEvent } from "../builder/evidence";
type Receipt = {
  connectionId: string;
  receiptId: string;
  sessionId: string;
  runId: string;
  commit: string;
  collectedAt: string;
  origin?: "operator-live-aws";
  scanRecords?: string[];
};
/** Internal persistence only. HTTP imports never call this authority boundary. */
export async function retainInternalCollectorEvent(connectionId:string,sessionId:string,event:EvidenceEvent,
  context:Pick<Receipt,"origin"|"scanRecords">={}) {
  const bundle=await retainEvent(connectionId,JSON.stringify(event),undefined,"browser-owner",true);
  const receipt:Receipt={connectionId,receiptId:bundle.id,sessionId,runId:event.run.id,commit:event.subject.revision,
    collectedAt:new Date().toISOString(),...context};
  const key=storageKey(["collector-receipts",sessionId,connectionId+"-"+bundle.id+".json"]);
  if(!(await readObject(key)))await writeObjectOnce(key,receipt);
  return bundle;
}
/** Internal collector boundary. There is deliberately no receipt creation HTTP endpoint. */
async function retainFetched(
  connectionId: string,
  sessionId: string,
  result: Awaited<ReturnType<typeof readGithubRelease>>,
) {
  const started=Date.now();
  const diagnostic=(stage:string)=>{if(process.env.AEGIS_COLLECTION_DIAGNOSTICS==="true")console.info("GitHub collection stage",{stage,elapsedMs:Date.now()-started});};
  const bundle = await retainInternalCollectorEvent(connectionId,sessionId,result.event);
  diagnostic("native-bundle-retained");
  diagnostic("native-receipt-retained");
  if ((await readConnection(connectionId))?.github)
    await (await import("../server/release-evidence")).formReleaseEvidence(sessionId, connectionId, bundle.id);
  diagnostic("release-projection-refreshed");
  await (
    await import("../agent/retest")
  ).satisfyCollectedRetests(sessionId, connectionId);
  diagnostic("retest-requests-refreshed");
  await (await import("../github/poam-gate")).refreshConnectionGates(sessionId, connectionId);
  diagnostic("pr-gates-refreshed");
  return bundle;
}
export async function collectAndRetainRelease(
  connectionId: string,
  sessionId: string,
  input: Parameters<typeof collectGithubRelease>[0],
) {
  return retainFetched(
    connectionId,
    sessionId,
    await collectGithubRelease(input),
  );
}
/** CLI collector uses a read-only GitHub client; it cannot accept caller evidence bytes. */
export async function fetchAndRetainRelease(
  connectionId: string,
  sessionId: string,
  client: Octokit,
  owner: string,
  repo: string,
  runId: number,
) {
  return retainFetched(
    connectionId,
    sessionId,
    await readGithubRelease(client, owner, repo, runId),
  );
}
export async function trustedReleases(
  sessionId: string,
  connectionId?: string,
  origin = process.env.AEGIS_PUBLIC_ORIGIN ?? "http://localhost",
) {
  const keys = await objectKeys(
    storageKey(["collector-receipts", sessionId]) + "/",
  );
  const receipts = (
    await Promise.all(keys.map((k) => readObject<Receipt>(k)))
  ).filter(
    (r): r is Receipt =>
      !!r &&
      r.sessionId === sessionId &&
      (!connectionId || r.connectionId === connectionId),
  );
  // Independent immutable receipts share the storage backend's bounded read pool.
  // Do not serialize every network round trip inside each closure proof read.
  const releases = (await Promise.all(receipts.map(async receipt => {
    const [c, b] = await Promise.all([
      readConnection(receipt.connectionId),
      readBundle(receipt.connectionId, receipt.receiptId),
    ]);
    if (
      !c ||
      c.revokedAt ||
      !b ||
      b.event.subject.revision !== receipt.commit ||
      b.event.run.id !== receipt.runId
    )
      return [];
    return connectedReleases(
        { ...c, revokedAt: null, history: [summarizeBuilderBundle(b)] },
        origin,
      );
  }))).flat();
  return releases.sort(
    (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt),
  );
}
