import { getDigestRefusal } from "@/lib/server/digest-handlers";
import { withSession } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(req: Request, context: { params: Promise<{ objectKey: string }> }) {
  return withSession(req, async () => {
    const { objectKey } = await context.params;
    return getDigestRefusal(decodeURIComponent(objectKey));
  });
}
