import { connectionRoute, apiJson } from "@/lib/agent/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET(req: Request) {
  return connectionRoute(req, async (a) => {
    if (a.agent)
      await (
        await import("@/lib/agent/audit")
      ).appendAgentActivity(a.connectionId, {
        tokenId: a.agent.id,
        tool: "ping",
        inputs: {},
        result: "recorded",
        refusalReason: null,
      });
    return apiJson({
      ok: true,
      connection_id: a.connectionId,
      authenticated_as: a.agent ? "agent" : "browser_owner",
      scopes: a.agent?.scopes ?? null,
      checked_at: new Date().toISOString(),
    });
  });
}
