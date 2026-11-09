import {
  connectionRoute,
  apiJson,
  agentHttpError,
  ownerConnection,
} from "@/lib/agent/http";
import { decideApproval, proposalKey } from "@/lib/agent/approvals";
import {
  connectionDecisions,
  filterDecisions,
  workspaceDecisions,
} from "@/lib/agent/decisions";
import { requireIssoReview } from "@/lib/agent/review-access";
import { readRemediation } from "@/lib/aegis/remediation-store";
import { boundedBody } from "@/lib/server/builder-http";
import { appendTimeline } from "@/lib/timeline/store";
import { personSource } from "@/lib/aegis/item-source";
import { readSessionId } from "@/lib/aegis/store";
import { containsSecret, redactText } from "@/lib/aegis/gates/redact";
import { randomUUID } from "node:crypto";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET(req: Request) {
  if (!new URL(req.url).searchParams.has("connection"))
    return workspaceDecisions(req);
  return connectionRoute(req, async (a) =>
    apiJson({
      items: filterDecisions(
        await connectionDecisions(
          a.connectionId,
          a.sessionId,
          new URL(req.url).origin,
        ),
        new URL(req.url).searchParams,
      ),
    }),
  );
}
export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(await boundedBody(req));
  } catch (e) {
    return agentHttpError(e);
  }
  const proposalId =
    typeof body?.proposal_id === "string" ? body.proposal_id : undefined;
  const response = await connectionRoute(
    req,
    async (a) => {
      const record = (await readRemediation(a.sessionId))?.records.find(
        (r) => r.key === proposalKey(a.connectionId),
      );
      const attributed =
        (record?.issueDrafts ?? []).some(
          (v) =>
            (v as { id: string }).id === proposalId &&
            (v as { source_label?: unknown }).source_label !== undefined,
        ) ||
        (record?.issueTriage ?? []).some(
          (v) =>
            (v as { id: string }).id === proposalId &&
            (v as { source_label?: unknown }).source_label !== undefined,
        );
      await requireIssoReview(req, a.owner!, attributed);
      return apiJson(
        await decideApproval(
          a.connectionId,
          a.sessionId,
          body,
          new URL(req.url).origin,
        ),
      );
    },
    {
      human: true,
      write: true,
      poamItemId: proposalId,
      findingId:
        typeof body?.finding_id === "string" ? body.finding_id : undefined,
    },
  );
  let historyOwnerVerified = false;
  if (
    response.status >= 400 &&
    !req.headers.has("authorization") &&
    proposalId
  ) {
    try {
      const connectionId =
        new URL(req.url).searchParams.get("connection") ?? "";
      await ownerConnection(req, connectionId);
      historyOwnerVerified = true;
      const sessionId = readSessionId(req.headers.get("cookie")),
        record = sessionId
          ? (await readRemediation(sessionId))?.records.find(
              (r) => r.key === proposalKey(connectionId),
            )
          : null;
      const triage = record?.issueTriage?.find(
        (v) => (v as { id: string }).id === proposalId,
      ) as { issueId: string; poam_item_id?: string } | undefined;
      const reason = await response.clone().json(),
        code = reason.code ?? reason.error?.code ?? "invalid_request",
        message =
          typeof reason.error === "string"
            ? reason.error
            : (reason.error?.message ??
              "The person's review could not be recorded.");
      const name =
        typeof body.name === "string" &&
        body.name.length <= 200 &&
        !containsSecret(body.name)
          ? body.name.trim()
          : undefined;
      await appendTimeline(connectionId, {
        id: randomUUID(),
        kind: "person-action",
        source: {},
        source_label: personSource(name),
        reason_code: String(code),
        items: triage?.poam_item_id ? [triage.poam_item_id] : [proposalId],
        findings: triage
          ? [triage.issueId]
          : proposalId.startsWith("proposal:")
            ? [proposalId.split(":").at(-1)!]
            : [],
        commit: "",
        observedAt: new Date().toISOString(),
        artifactSha256: [],
        controls: [],
        collected: false,
        summary: { result: "refused", message: redactText(message) },
      });
    } catch {
      if (historyOwnerVerified)
        return agentHttpError(new Error("Item history unavailable."));
    }
  }
  return response;
}
