import { readControlTimeline } from "@/lib/server/monitoring-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(req: Request, context: { params: Promise<{ id: string; controlId: string }> }): Promise<Response> {
  return context.params.then(({ id, controlId }) => readControlTimeline(req, id, controlId));
}
