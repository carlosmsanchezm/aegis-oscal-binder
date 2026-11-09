import { getControlPart, putControlPart } from "@/lib/server/handlers";
import { readJson, withSession } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(req: Request, context: { params: Promise<{ controlId: string; statementId: string }> }) {
  return withSession(req, async () => {
    const { controlId, statementId } = await context.params;
    return getControlPart(decodeURIComponent(controlId), decodeURIComponent(statementId));
  });
}

export function PUT(req: Request, context: { params: Promise<{ controlId: string; statementId: string }> }) {
  return withSession(req, async () => {
    const { controlId, statementId } = await context.params;
    return putControlPart(decodeURIComponent(controlId), decodeURIComponent(statementId), await readJson(req));
  });
}
