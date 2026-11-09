import { builderOwner, ownsConnection, readConnection } from "@/lib/server/builder-store";
import { builderMutationDenial } from "@/lib/account/access";
import { builderHandler, builderJson, BuilderRequestError, checkBrowserMutation } from "@/lib/server/builder-http";
import { importCollectorEvent } from "@/lib/server/builder-import";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  return builderHandler(async () => {
    checkBrowserMutation(req);
    const denied = await builderMutationDenial(req);
    if (denied) throw new BuilderRequestError(denied.message, denied.status);
    const { id } = await context.params;
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new BuilderRequestError("Connection not found.", 404);
    const connection = await readConnection(id);
    if (!connection || !ownsConnection(connection, builderOwner(req.headers.get("cookie")))) throw new BuilderRequestError("Connection not found.", 404);
    if (connection.revokedAt) throw new BuilderRequestError("Connection uploads are revoked.", 409);
    const bundle = await importCollectorEvent(req, id);
    return builderJson({ ok: true, evidenceId: bundle.id, receivedAt: bundle.receivedAt, artifactCount: bundle.event.artifacts.length }, 201);
  });
}
