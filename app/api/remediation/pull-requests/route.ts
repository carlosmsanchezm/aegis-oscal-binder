import { connectionRoute, apiJson, agentHttpError } from "@/lib/agent/http";
import { boundedBody } from "@/lib/server/builder-http";
import { pullRequestLinks, proposeFixPr } from "@/lib/github/pull-requests";
import { appendAgentActivity } from "@/lib/agent/audit";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET(req: Request) {
  return connectionRoute(req, async a => apiJson({pullRequests: await pullRequestLinks(a.sessionId, a.connectionId)}));
}
export async function POST(req: Request) {
  try {
    const input = JSON.parse(await boundedBody(req));
    return connectionRoute(req, async a => {
      if (a.agent) await appendAgentActivity(a.connectionId, {tokenId: a.agent.id, tool: "propose_fix_pr", inputs: input, result: "requested", refusalReason: null});
      const result = await proposeFixPr(a.sessionId, a.connectionId, a.agent ? `agent:${a.agent.id}` : "person:browser-owner", input);
      if (a.agent) await appendAgentActivity(a.connectionId, {tokenId: a.agent.id, tool: "propose_fix_pr", inputs: input, result: "recorded", refusalReason: null});
      return apiJson(result);
    }, {connectionId: input.connectionId, poamItemId: input.poamItemId, scope: "propose_fix_pr", write: true});
  } catch(e) { return agentHttpError(e); }
}
