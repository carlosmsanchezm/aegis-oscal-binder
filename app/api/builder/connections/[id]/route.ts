import { builderOwner, ownsConnection, readConnection, revokeConnection } from "@/lib/server/builder-store";
import { builderMutationDenial } from "@/lib/account/access";
import { builderHandler, builderJson, BuilderRequestError, checkBrowserMutation } from "@/lib/server/builder-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function DELETE(req: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  return builderHandler(async () => {
    checkBrowserMutation(req);
    const denied = await builderMutationDenial(req);
    if (denied) throw new BuilderRequestError(denied.message, denied.status);
    const { id } = await context.params;
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new BuilderRequestError("Connection not found.", 404);
    const connection = await readConnection(id);
    if (!connection || !ownsConnection(connection, builderOwner(req.headers.get("cookie")))) throw new BuilderRequestError("Connection not found.", 404);
    await revokeConnection(id);
    return builderJson({ ok: true });
  });
}
