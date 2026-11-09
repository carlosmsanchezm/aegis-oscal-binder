import { connectionRoute, apiJson } from "@/lib/agent/http";
import { revokeAgentToken } from "@/lib/agent/agent-token";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function DELETE(
  req: Request,
  context: { params: Promise<{ id: string }> },
) {
  return connectionRoute(
    req,
    async (a) => {
      const { id } = await context.params;
      await revokeAgentToken(a.connectionId, a.owner!, id);
      return apiJson({ revoked: true, id });
    },
    { human: true, write: true },
  );
}
