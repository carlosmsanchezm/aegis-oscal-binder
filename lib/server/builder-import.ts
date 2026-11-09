import { parseEvidenceEvent } from "@/lib/builder/evidence";
import { boundedBody, BuilderRequestError } from "./builder-http";
import { retainEvent, sha256, verifyBundle } from "./builder-store";

/** Browser import retains exact collector bytes and checks the same contract as CI intake. */
export async function importCollectorEvent(req: Request, connectionId: string) {
  const raw = await boundedBody(req);
  try {
    const event = parseEvidenceEvent(JSON.parse(raw));
    verifyBundle({ schema: "aegis.evidence-bundle.v1", id: sha256(raw), connectionId,
      receivedAt: new Date().toISOString(), rawEvent: raw, event, integrity: "verified", authentication: "browser-owner" });
    if (Date.parse(event.run.observedAt) > Date.now() + 300_000) throw new Error("Observation time is in the future.");
  } catch (error) {
    throw new BuilderRequestError(error instanceof SyntaxError ? "Evidence event must be valid JSON." : error instanceof Error ? error.message : "Invalid evidence event.");
  }
  return retainEvent(connectionId, raw, undefined, "browser-owner");
}
