import { getPlanOfActionFile, postPlanOfActionFile } from "@/lib/server/remediation-draft";
import { withSession } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(req: Request) {
  return withSession(req, () => getPlanOfActionFile(new URL(req.url), req.headers.get("cookie")));
}

export function POST(req: Request) {
  return withSession(req, () => postPlanOfActionFile(req));
}
