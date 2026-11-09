import { postEvidenceFile } from "@/lib/server/handlers";
import { withSession } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(req: Request, context: { params: Promise<{ controlId: string }> }) {
  return withSession(req, async () => {
    const { controlId } = await context.params;
    return postEvidenceFile(decodeURIComponent(controlId), req);
  });
}
