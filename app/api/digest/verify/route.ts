import { getDigestCheck, postDigestCheck } from "@/lib/server/digest-handlers";
import { readJson, withSession } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(req: Request) {
  return withSession(req, () => getDigestCheck());
}

export function POST(req: Request) {
  return withSession(req, async () => postDigestCheck(await readJson(req)));
}
