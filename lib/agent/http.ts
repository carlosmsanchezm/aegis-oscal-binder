import {
  builderOwner,
  readConnection,
  ownsConnection,
} from "../server/builder-store";
import { builderMutationDenial } from "../account/access";
import { hasAgentScope, AgentAccessError } from "./agent-token";
import { AegisError } from "../aegis/errors";
import {reportBackendFailure} from "../server/backend-diagnostics";
import {
  BuilderRequestError,
  checkBrowserMutation,
} from "../server/builder-http";
export async function ownerConnection(
  req: Request,
  connectionId: string,
  write = false,
) {
  if (write) {
    checkBrowserMutation(req);
    const denied = await builderMutationDenial(req);
    if (denied) throw new AgentAccessError(denied.message, denied.status);
  }
  const owner = builderOwner(req.headers.get("cookie")),
    connection = await readConnection(connectionId);
  if (
    !owner ||
    !connection ||
    connection.revokedAt ||
    !ownsConnection(connection, owner)
  )
    throw new AgentAccessError("Connection is unavailable.", 403);
  return { owner, connection };
}
export function agentHttpError(e: unknown) {
  const status =
    e instanceof AgentAccessError ||
    e instanceof AegisError ||
    e instanceof BuilderRequestError
      ? e.status
      : e instanceof SyntaxError
        ? 400
        : 503;
  if(status===503)reportBackendFailure(e);
  const code =
    e instanceof AgentAccessError
      ? e.code
      : e instanceof AegisError && e.code === "EVIDENCE_REQUIRED"
        ? "needs_server_evidence"
        : status === 400
          ? "invalid_request"
          : status === 403
            ? "scope"
            : "operation_failed";
  const message =
    e instanceof SyntaxError
      ? "Invalid JSON request."
      : status === 503
        ? "Backend storage or evidence is unavailable."
        : e instanceof Error
          ? e.message
          : "Invalid request.";
  return Response.json(
    { error: message, code, message },
    { status, headers: { "cache-control": "private, no-store" } },
  );
}

/** Shared browser/agent authorization for connection-scoped API data. */
export async function connectionRoute(
  req: Request,
  run: (access: {
    connectionId: string;
    sessionId: string;
    agent: import("./agent-token").AgentToken | null;
    owner: string | null;
  }) => Promise<Response>,
  options: {
    human?: boolean;
    write?: boolean;
    scope?: import("./agent-token").AgentScope;
    connectionId?: string;
    findingId?: string;
    poamItemId?: string;
  } = {},
) {
  const operation = new URL(req.url).pathname.replace(
    /^\/api\/agent\/tokens\/[^/]+\/?$/,
    "/api/agent/tokens/:id",
  );
  const execute = async () => {
    let principal: import("./agent-token").AgentToken | undefined;
    try {
      const connectionId =
        options.connectionId ??
        new URL(req.url).searchParams.get("connection") ??
        "";
      if (!/^[a-f0-9-]{36}$/.test(connectionId))
        throw new AgentAccessError(
          "A connection id is required.",
          400,
          "invalid_request",
        );
      const authorization = req.headers.get("authorization");
      if (authorization !== null) {
        const { authenticateAgent } = await import("./agent-token");
        const token = /^Bearer (\S+)$/.exec(authorization)?.[1];
        const agent = await authenticateAgent(token, undefined, operation);
        principal = agent;
        if (!hasAgentScope(agent, options.scope ?? "read"))
          throw new AgentAccessError(
            "Agent scope is required: " + (options.scope ?? "read"),
            403,
            "scope",
          );
        if (agent.connectionId !== connectionId)
          throw new AgentAccessError(
            "Connection is unavailable.",
            403,
            "scope",
          );
        if (options.human)
          throw new AgentAccessError(
            "A person must use the browser owner session for this action.",
            403,
            "needs_human",
          );
        if (options.write) checkBrowserMutation(req);
        return await run({
          connectionId,
          sessionId: agent.sessionId,
          agent,
          owner: null,
        });
      }
      const { owner } = await ownerConnection(req, connectionId, options.write);
      const { getSession, readActiveSession } = await import("../aegis/store");
      const sessionId = getSession().id;
      if (!(await readActiveSession(sessionId)))
        throw new AgentAccessError("Browser session is unavailable.");
      return await run({ connectionId, sessionId, agent: null, owner });
    } catch (error) {
      const auditIdentity = principal
        ? { tokenId: principal.id, connectionId: principal.connectionId }
        : error instanceof AgentAccessError
          ? error.auditIdentity
          : undefined;
      if (auditIdentity) {
        try {
          const { appendAgentActivity } = await import("./audit"),
            { refusalCode } = await import("./refusal");
          let findingId = options.findingId;
          if (
            !findingId &&
            principal &&
            options.poamItemId?.startsWith("triage:")
          ) {
            const record = (
              await (
                await import("../aegis/remediation-store")
              ).readRemediation(principal.sessionId)
            )?.records.find(
              (r) =>
                r.key ===
                "binder.plan-proposals.v1:binder-connection:" +
                  auditIdentity.connectionId,
            );
            findingId = (
              record?.issueTriage?.find(
                (v) => (v as { id: string }).id === options.poamItemId,
              ) as { issueId: string } | undefined
            )?.issueId;
          }
          await appendAgentActivity(auditIdentity.connectionId, {
            tokenId: auditIdentity.tokenId,
            tool: operation,
            inputs: {
              connectionId: new URL(req.url).searchParams.get("connection"),
              ...(findingId ? { issueId: findingId } : {}),
              ...(options.poamItemId
                ? { poam_item_id: options.poamItemId }
                : {}),
            },
            result: "refused",
            refusalReason:
              error instanceof AgentAccessError
                ? error.message
                : "The API operation could not be completed.",
            refusalCode: refusalCode(error),
          });
        } catch {
          return agentHttpError(new Error("Audit storage unavailable."));
        }
      }
      return agentHttpError(error);
    }
  };
  const response = req.headers.has("authorization")
    ? await execute()
    : await (await import("../server/http")).withSession(req, execute);
  response.headers.set("cache-control", "private, no-store");
  response.headers.set("vary", "Cookie, Authorization");
  return response;
}
export function apiJson(value: unknown, status = 200) {
  return Response.json(value, {
    status,
    headers: { "cache-control": "private, no-store" },
  });
}
