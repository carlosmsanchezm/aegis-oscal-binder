import { connectionRoute, apiJson } from "@/lib/agent/http";
import { queryTimeline, matchesTimelineFinding } from "@/lib/timeline/store";
import { pageLog } from "@/lib/agent/log-page";
import { itemSource } from "@/lib/aegis/item-source";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET(req: Request) {
  return connectionRoute(req, async (a) => {
    const q = new URL(req.url).searchParams,
      control = q.get("control")?.toUpperCase(),
      finding = q.get("finding");
    const all = await queryTimeline(a.connectionId),
      filtered = all.filter(
        (e) =>
          (!control || e.body.controls.includes(control)) &&
          (!finding || matchesTimelineFinding(e.body, finding)),
      );
    const chain =
      "evidence:" +
      a.connectionId +
      (control || finding
        ? ":" + JSON.stringify([control ?? null, finding ?? null])
        : "");
    const page = pageLog(filtered, q, chain, all);
    return apiJson({
      ...page,
      verified: true,
      entries: page.entries.map((e) => ({
        ...e,
        source_label:
          e.body.source_label ??
          (e.body.collected
            ? { kind: "server-collected" }
            : e.body.review
              ? {
                  kind: "person",
                  identity_verification: "typed_unverified",
                  name: e.body.review.name,
                }
              : itemSource(null)),
        reason_code:
          e.body.reason_code ??
          (e.body.kind === "human-review"
            ? "person_decision_recorded"
            : "evidence_recorded"),
      })),
    });
  });
}
