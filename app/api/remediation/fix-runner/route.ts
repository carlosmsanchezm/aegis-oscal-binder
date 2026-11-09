import { connectionRoute, apiJson, agentHttpError } from "@/lib/agent/http";
import { boundedBody } from "@/lib/server/builder-http";
import { abandonFix, enqueueFixes, getFixRunner, refreshFixRunner, retryRejectedOpen } from "@/lib/agent/fix-runner";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET(req: Request) {
  return connectionRoute(req, async a => apiJson(await getFixRunner(a.sessionId, a.connectionId)), {scope:"propose_fix_pr"});
}
export async function POST(req: Request) {
  try {
    const input = JSON.parse(await boundedBody(req));
    return connectionRoute(req, async a => {
      if (input.operation === "enqueue") return apiJson(await enqueueFixes(a.sessionId, a.connectionId, input.poamItemIds));
      if (input.operation === "refresh") return apiJson(await refreshFixRunner(a.sessionId, a.connectionId) ?? await getFixRunner(a.sessionId, a.connectionId));
      if (input.operation === "abandon" && typeof input.assignmentId === "string") return apiJson(await abandonFix(a.sessionId, a.connectionId, input.assignmentId));
      if (input.operation === "retry-rejected-open" && typeof input.assignmentId === "string") return apiJson(await retryRejectedOpen(a.sessionId, a.connectionId, input.assignmentId));
      return apiJson({error:"Use enqueue, refresh, abandon or retry-rejected-open."}, 400);
    }, {connectionId:input.connectionId, human:true, write:true});
  } catch (error) {return agentHttpError(error);}
}
