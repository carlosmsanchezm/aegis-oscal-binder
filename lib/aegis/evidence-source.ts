import { readObject } from "../immutable-log";
import { storageKey } from "../storage-key";
import { readBundle } from "../server/builder-store";
import { personSource, type ItemSource } from "./item-source";
/** Consult only private collector receipts; uploaded event flags do not confer provenance. */
export async function evidenceSource(
  sessionId: string | null | undefined,
  connectionId: string,
  receiptId: string,
): Promise<ItemSource> {
  if (!sessionId || !/^[a-f0-9]{32}$/.test(sessionId)) return personSource();
  const receipt = await readObject<{
    sessionId: string;
    connectionId: string;
    receiptId: string;
    runId: string;
    commit: string;
  }>(
    storageKey([
      "collector-receipts",
      sessionId,
      connectionId + "-" + receiptId + ".json",
    ]),
  );
  if (
    !receipt ||
    receipt.sessionId !== sessionId ||
    receipt.connectionId !== connectionId ||
    receipt.receiptId !== receiptId
  )
    return personSource();
  const bundle = await readBundle(connectionId, receiptId);
  return bundle &&
    bundle.event.run.id === receipt.runId &&
    bundle.event.subject.revision === receipt.commit
    ? { kind: "server-collected" }
    : personSource();
}
