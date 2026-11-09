import { postRegenerateExport } from "@/lib/server/digest-handlers";
import { readJson, withSession } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(req: Request) {
  return withSession(req, async () => postRegenerateExport(await readJson(req)));
}
