import { getSession } from "@/lib/aegis/store";
import { boundedBody } from "@/lib/server/builder-http";
import {
  createAgentToken,
  listAgentTokens,
  revokeAgentToken,
  type AgentScope,
} from "@/lib/agent/agent-token";
import { connectionRoute, apiJson, agentHttpError } from "@/lib/agent/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET(req: Request) {
  return connectionRoute(
    req,
    async (a) =>
      apiJson({ tokens: await listAgentTokens(a.connectionId, a.owner!) }),
    { human: true },
  );
}
export async function POST(req: Request) {
  try {
    const body = JSON.parse(await boundedBody(req));
    return connectionRoute(
      req,
      async (a) => {
        if (!Array.isArray(body.scopes))
          return apiJson({ error: "Scopes required." }, 400);
        const session = getSession();
        session.commit(session.state);
        await session.flush();
        const result = await createAgentToken(
          a.connectionId,
          a.owner!,
          a.sessionId,
          body.scopes as AgentScope[],
          { expires_at: body.expires_at },
        );
        return apiJson(
          {
            token: result.token,
            id: result.record.id,
            scopes: result.record.scopes,
            expires_at: result.record.expires_at,
          },
          201,
        );
      },
      { human: true, write: true, connectionId: body.connectionId },
    );
  } catch (error) {
    return agentHttpError(error);
  }
}
export async function DELETE(req: Request) {
  try {
    const body = JSON.parse(await boundedBody(req));
    return connectionRoute(
      req,
      async (a) => {
        await revokeAgentToken(a.connectionId, a.owner!, body.id);
        return apiJson({ revoked: true });
      },
      { human: true, write: true, connectionId: body.connectionId },
    );
  } catch (error) {
    return agentHttpError(error);
  }
}
