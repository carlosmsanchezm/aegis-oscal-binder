import { withSession, jsonOk } from "@/lib/server/http";
import {
  handleIssueAction,
  performIssueAction,
  UnsupportedTriageOutcomeError,
} from "@/lib/server/issue-actions";
import { connectionRoute, apiJson, agentHttpError } from "@/lib/agent/http";
import { boundedBody } from "@/lib/server/builder-http";
import { findingItems } from "@/lib/agent/items";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET(req: Request) {
  const finding = new URL(req.url).searchParams.get("finding") ?? undefined;
  return connectionRoute(
    req,
    async (a) => {
      const items = await findingItems(
        a.connectionId,
        a.sessionId,
        new URL(req.url).origin,
        finding,
      );
      if (a.agent && finding)
        await (
          await import("@/lib/agent/audit")
        ).appendAgentActivity(a.connectionId, {
          tokenId: a.agent.id,
          tool: "read_findings",
          inputs: finding.startsWith("proposal:")
            ? { poam_item_id: finding }
            : { issueId: finding },
          result: "recorded",
          refusalReason: null,
        });
      return apiJson(items);
    },
    {
      findingId: finding?.startsWith("proposal:") ? undefined : finding,
      poamItemId: finding?.startsWith("proposal:") ? finding : undefined,
    },
  );
}
export async function POST(req: Request) {
  if (req.headers.has("authorization")) {
    try {
      const body = JSON.parse(await boundedBody(req));
      return connectionRoute(
        req,
        async (a) => {
          const { appendAgentActivity } = await import("@/lib/agent/audit");
          const tool =
              body.action === "triage" ? "triage_finding" : "draft_plan",
            inputs = {
              issueId: body.issueId,
              poam_item_id: body.poamItemId,
              outcome: body.outcome,
            };
          await appendAgentActivity(a.connectionId, {
            tokenId: a.agent!.id,
            tool,
            inputs,
            result: "requested",
            refusalReason: null,
          });
          const result = await performIssueAction({
            connectionId: a.connectionId,
            sessionId: a.sessionId,
            receiptId: body.receiptId,
            issueId: body.issueId,
            action: body.action,
            outcome: body.outcome,
            reason: body.reason,
            draft: body.draft,
            poamItemId: body.poamItemId,
            actor: "agent:" + a.agent!.id,
            at: new Date().toISOString(),
            origin: new URL(req.url).origin,
          });
          await appendAgentActivity(a.connectionId, {
            tokenId: a.agent!.id,
            tool,
            inputs,
            result: "recorded",
            refusalReason: null,
          });
          return apiJson(result);
        },
        {
          connectionId: body.connectionId,
          findingId:
            typeof body.issueId === "string" ? body.issueId : undefined,
          poamItemId:
            typeof body.poamItemId === "string" ? body.poamItemId : undefined,
          write: true,
          scope: body.action === "triage" ? "propose_triage" : "draft_poam",
        },
      );
    } catch (e) {
      return agentHttpError(e);
    }
  }
  return withSession(req, async () => {
    try {
      return await handleIssueAction(req);
    } catch (error) {
      if (error instanceof UnsupportedTriageOutcomeError) return agentHttpError(error);
      return jsonOk(
        {
          error:
            error instanceof Error
              ? error.message
              : "Issue action unavailable.",
        },
        503,
      );
    }
  });
}
