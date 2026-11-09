import { authenticatesConnection, readConnection, retainEvent } from "@/lib/server/builder-store";
import { boundedBody, builderHandler, builderJson, BuilderRequestError } from "@/lib/server/builder-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  return builderHandler(async () => {
    const { id } = await context.params;
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new BuilderRequestError("Connection not found.", 404);
    const connection = await readConnection(id);
    const token = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.get("authorization") ?? "")?.[1] ?? null;
    if (!connection || !authenticatesConnection(connection, token)) throw new BuilderRequestError("Connection credential rejected.", 401);
    const raw = await boundedBody(req);
    // Validate submitted bytes separately so malformed inputs are 400, store failures 503.
    const { parseEvidenceEvent } = await import("@/lib/builder/evidence");
    const { verifyBundle, sha256 } = await import("@/lib/server/builder-store");
    let input: unknown;
    try { input = JSON.parse(raw); } catch { throw new BuilderRequestError("Evidence event must be valid JSON."); }
    try {
      const event = parseEvidenceEvent(input);
      verifyBundle({ schema: "aegis.evidence-bundle.v1", id: sha256(raw), connectionId: id, receivedAt: new Date().toISOString(), rawEvent: raw, event, integrity: "verified", authentication: "connection-token" });
      if (Date.parse(event.run.observedAt) > Date.now() + 300_000) throw new Error("Observation time is in the future.");
    } catch (error) { throw new BuilderRequestError(error instanceof Error ? error.message : "Invalid evidence event."); }
    const bundle = await retainEvent(id, raw);
    const releaseCollection = await (await import("@/lib/server/release-notification")).collectNotifiedRelease(id, bundle.event);
    return builderJson({ ok: true, evidenceId: bundle.id, receivedAt: bundle.receivedAt, artifactCount: bundle.event.artifacts.length, releaseCollection }, 201);
  });
}
