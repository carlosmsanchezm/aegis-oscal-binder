import { postLoad } from "@/lib/server/handlers";
import { readJson, withSession } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(req: Request) {
  return withSession(req, async () => postLoad(await readJson(req)));
}
