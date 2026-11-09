import { getRemediation, putRemediation, resetProposalDecisions } from "@/lib/server/remediation-draft";
import { withSession } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(req: Request) {
  return withSession(req, () => getRemediation(req));
}

export function PUT(req: Request) {
  return withSession(req, () => putRemediation(req));
}

export function DELETE(req: Request) {
  return withSession(req, () => resetProposalDecisions(req));
}
