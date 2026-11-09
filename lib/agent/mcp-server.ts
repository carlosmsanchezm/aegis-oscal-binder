import { refusalCode } from "./refusal";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  authenticateAgent,
  hasAgentScope,
  AgentAccessError,
  type AgentScope,
} from "./agent-token";
import { agentAction } from "./service";
import { appendAgentActivity, auditSafe } from "./audit";
export const TOOL_SCOPES: Record<string, AgentScope> = {
  get_package: "read",
  list_findings: "read",
  get_gate_status: "read",
  get_evidence: "read",
  get_timeline: "read",
  get_agent_activity: "read",
  draft_plan: "draft",
  triage_finding: "triage",
  request_retest: "retest",
  propose_fix_pr: "propose_fix_pr",
  claim_fix: "propose_fix_pr",
  get_fix_assignments: "propose_fix_pr",
  attempt_close: "close",
};
const SHAPE = {
  runnerAssignmentId: z.string().uuid().optional(),
  operation: z.enum(["register", "open"]).optional(),
  prUrl: z.string().max(500).optional(),
  prNumber: z.number().int().positive().optional(),
  head: z.string().max(255).optional(),
  base: z.string().max(255).optional(),
  title: z.string().max(200).optional(),
  receiptId: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  issueId: z.string().max(200).optional(),
  control: z.string().max(80).optional(),
  outcome: z.enum(["fix-now", "plan-it"]).optional(),
  reason: z.string().max(4000).optional(),
  poamItemId: z.string().max(200).optional(),
  draft: z
    .object({
      risk: z.string().min(1).max(6000),
      action: z.string().min(1).max(6000),
      verification: z.string().min(1).max(6000),
    })
    .optional(),
};
export function createMcpServer(
  credential: () => string | undefined,
  origin = "http://localhost:3000",
) {
  const server = new McpServer({ name: "binder-agent", version: "1.0.0" });
  for (const [tool, scope] of Object.entries(TOOL_SCOPES))
    server.registerTool(
      tool,
      {
        description: `${tool}: scoped to this agent connection. Collected evidence and human gates are enforced by the server.`,
        inputSchema: SHAPE,
      },
      async (input) => {
        // Reauthenticate every invocation so revocation also works for persistent stdio clients.
        let principal;
        try {
          principal = await authenticateAgent(credential(), undefined, tool);
        } catch (e) {
          if (e instanceof AgentAccessError && e.auditIdentity)
            await appendAgentActivity(e.auditIdentity.connectionId, {
              tokenId: e.auditIdentity.tokenId,
              tool,
              inputs: input,
              result: "refused",
              refusalReason: e.message,
              refusalCode: e.code,
            });
          return failure(e);
        }
        const write = scope !== "read";
        // Audit intent before the write; refuse to act if the audit store is unavailable.
        if (write)
          await appendAgentActivity(principal.connectionId, {
            tokenId: principal.id,
            tool,
            inputs: input,
            result: "requested",
            refusalReason: null,
          });
        try {
          if (!hasAgentScope(principal, scope))
            throw new AgentAccessError(
              "Agent scope is required: " + scope,
              403,
              "scope",
            );
          let result: unknown;
          if (tool === "get_timeline") {
            const { queryTimeline } = await import("../timeline/store");
            result = await queryTimeline(principal.connectionId, {
              control: input.control,
              finding: input.issueId,
            });
          } else result = await agentAction(principal, tool, input, origin);
          const refusal = (result as { refused?: boolean; problems?: string[] })
            ?.refused;
          await appendAgentActivity(principal.connectionId, {
            tokenId: principal.id,
            tool,
            inputs: input,
            result: refusal ? "refused" : "recorded",
            refusalReason: refusal
              ? (result as { problems: string[] }).problems.join(" ")
              : null,
            refusalCode: refusal
              ? ((result as { refusalCode?: import("./refusal").RefusalCode })
                  .refusalCode ?? "needs_server_evidence")
              : null,
          });
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result) }],
            ...(refusal ? { isError: true } : {}),
          };
        } catch (e) {
          await appendAgentActivity(principal.connectionId, {
            tokenId: principal.id,
            tool,
            inputs: input,
            result: "error",
            refusalReason: safeMessage(e),
            refusalCode: refusalCode(e),
          });
          return failure(e);
        }
      },
    );
  return server;
}
function safeMessage(e: unknown) {
  return String(
    auditSafe(e instanceof Error ? e.message : "Agent operation failed."),
  );
}
function failure(e: unknown) {
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text:
          e instanceof AgentAccessError && e.code === "token_expired"
            ? JSON.stringify({ code: e.code, message: safeMessage(e) })
            : safeMessage(e),
      },
    ],
  };
}
