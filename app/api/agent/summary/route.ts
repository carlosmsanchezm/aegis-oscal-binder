import { connectionRoute, apiJson } from "@/lib/agent/http";
import { agentSummary } from "@/lib/agent/summary";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET(req: Request) {
  return connectionRoute(req, async (a) =>
    apiJson(
      await agentSummary(a.connectionId, a.sessionId, new URL(req.url).origin),
    ),
  );
}
