import { patchControl } from "@/lib/server/handlers";
import { readJson, withSession } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function PATCH(req: Request, context: { params: Promise<{ controlId: string }> }) {
  return withSession(req, async () => {
    const { controlId } = await context.params;
    return patchControl(decodeURIComponent(controlId), await readJson(req));
  });
}
