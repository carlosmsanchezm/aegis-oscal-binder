import { postMonitoringCapture } from "@/lib/server/monitoring-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(req: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  return context.params.then(({ id }) => postMonitoringCapture(req, id, "ci"));
}
