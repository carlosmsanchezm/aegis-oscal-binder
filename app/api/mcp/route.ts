import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  authenticateAgent,
  hasAgentScope,
  AgentAccessError,
  recordAgentUse,
} from "@/lib/agent/agent-token";
import { appendAgentActivity } from "@/lib/agent/audit";
import { createMcpServer, TOOL_SCOPES } from "@/lib/agent/mcp-server";
import {
  checkBrowserMutation,
  BuilderRequestError,
  boundedBody,
} from "@/lib/server/builder-http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;
export async function POST(req: Request) {
  try {
    checkBrowserMutation(req);
    const token = /^Bearer (\S+)$/.exec(
      req.headers.get("authorization") ?? "",
    )?.[1];
    const principal = await authenticateAgent(token);
    const parsed = JSON.parse(await boundedBody(req));
    for (const request of Array.isArray(parsed) ? parsed : [parsed]) {
      if (request?.method === "tools/call") {
        const scope = TOOL_SCOPES[String(request.params?.name)];
        if (scope && !hasAgentScope(principal, scope)) {
          await recordAgentUse(principal, String(request.params.name));
          if (scope !== "read")
            await appendAgentActivity(principal.connectionId, {
              tokenId: principal.id,
              tool: String(request.params.name),
              inputs: request.params.arguments ?? {},
              result: "refused",
              refusalCode: "scope",
              refusalReason: "Agent scope is required: " + scope,
            });
          return Response.json(
            { error: "Agent scope is required: " + scope },
            { status: 403, headers: { "cache-control": "no-store" } },
          );
        }
      }
    }
    const server = createMcpServer(() => token, new URL(req.url).origin),
      transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
        maxRequestBodySize: 500_000,
      });
    await server.connect(transport);
    try {
      const response = await transport.handleRequest(req, {
        parsedBody: parsed,
      });
      const bytes = await response.arrayBuffer();
      return new Response(bytes, {
        status: response.status,
        headers: {
          ...Object.fromEntries(response.headers),
          "cache-control": "private, no-store",
        },
      });
    } finally {
      await server.close();
    }
  } catch (e) {
    if (e instanceof AgentAccessError && e.auditIdentity) {
      try {
        const parsed = JSON.parse(await boundedBody(req));
        for (const call of Array.isArray(parsed) ? parsed : [parsed])
          if (call?.method === "tools/call")
            await appendAgentActivity(e.auditIdentity.connectionId, {
              tokenId: e.auditIdentity.tokenId,
              tool: String(call.params?.name),
              inputs: call.params?.arguments ?? {},
              result: "refused",
              refusalReason: e.message,
              refusalCode: e.code,
            });
      } catch {}
    }
    const status =
      e instanceof AgentAccessError || e instanceof BuilderRequestError
        ? e.status
        : e instanceof SyntaxError
          ? 400
          : 503;
    return Response.json(
      {
        error:
          status === 503 ? "Agent service unavailable." : (e as Error).message,
        ...(e instanceof AgentAccessError && e.code === "token_expired"
          ? { code: e.code, message: e.message }
          : {}),
      },
      { status },
    );
  }
}
export function GET() {
  return Response.json(
    { error: "Stateless MCP uses POST." },
    { status: 405, headers: { Allow: "POST" } },
  );
}
