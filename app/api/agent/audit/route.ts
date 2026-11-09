import { agentSource } from "@/lib/aegis/item-source";
import { connectionRoute, apiJson } from "@/lib/agent/http";
import { getAgentActivity } from "@/lib/agent/audit";
import { legacyRefusalCode } from "@/lib/agent/refusal";
import { pageLog } from "@/lib/agent/log-page";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET(req: Request) {
  return connectionRoute(req, async (a) => {
    const page = pageLog(
      await getAgentActivity(a.connectionId),
      new URL(req.url).searchParams,
      "audit:" + a.connectionId,
    );
    return apiJson({
      ...page,
      entries: page.entries.map((row) => ({
        ...row,
        source_label: row.body.source_label ?? agentSource(row.body.tokenId),
        refusal: row.body.refusalReason
          ? {
              code:
                row.body.refusalCode ??
                legacyRefusalCode(row.body.refusalReason),
              message: row.body.refusalReason,
            }
          : null,
      })),
      verified: true,
    });
  });
}
