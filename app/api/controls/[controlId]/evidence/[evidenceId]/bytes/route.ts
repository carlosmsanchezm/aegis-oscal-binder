import { getEvidenceBytes } from "@/lib/server/digest-handlers";
import { withSession } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(req: Request, context: { params: Promise<{ controlId: string; evidenceId: string }> }) {
  return withSession(req, async () => {
    const { controlId, evidenceId } = await context.params;
    return getEvidenceBytes(decodeURIComponent(controlId), decodeURIComponent(evidenceId));
  });
}
