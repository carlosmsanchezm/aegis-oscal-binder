import { cronAuthorized } from "@/lib/monitoring/cron-auth";
import { monitoringCopy } from "@/lib/monitoring/copy";
import { runScheduledScans } from "@/lib/monitoring/schedule";
import { BuilderRequestError, builderHandler, builderJson } from "@/lib/server/builder-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(req: Request): Promise<Response> {
  return builderHandler(async () => {
    if (!cronAuthorized(req.headers.get("authorization"), process.env.CRON_SECRET)) throw new BuilderRequestError(monitoringCopy.cronRejected, 401);
    try {
      const scans = await runScheduledScans();
      return builderJson({ ok: true, scans });
    } catch (error) {
      if (error instanceof BuilderRequestError) throw error;
      throw new BuilderRequestError(monitoringCopy.scanFailed, 503);
    }
  });
}
