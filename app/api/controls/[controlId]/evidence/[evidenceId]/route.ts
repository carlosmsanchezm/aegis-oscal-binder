import { patchEvidence } from "@/lib/server/handlers";
import { readJson, withSession } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function PATCH(req: Request, context: { params: Promise<{ controlId: string; evidenceId: string }> }) {
  return withSession(req, async () => {
    const { controlId, evidenceId } = await context.params;
    return patchEvidence(decodeURIComponent(controlId), decodeURIComponent(evidenceId), await readJson(req));
  });
}
