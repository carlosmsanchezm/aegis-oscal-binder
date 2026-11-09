import { getSystemSecurityPlanFile } from "@/lib/server/remediation-draft";
import { withSession } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(req: Request) {
  return withSession(req, () => getSystemSecurityPlanFile(new URL(req.url), req.headers.get("cookie")));
}
