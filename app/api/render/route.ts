import { postRender } from "@/lib/server/handlers";
import { readJson, withSession } from "@/lib/server/http";
import { AegisError } from "@/lib/aegis";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(req: Request) {
  return withSession(req, async () => {
    const body = await readJson(req);
    const target = body.target ?? "both";
    if (target !== "word" && target !== "excel" && target !== "both") {
      throw new AegisError("BAD_REQUEST", 'target must be "word", "excel", or "both"', 400);
    }
    return postRender(target);
  });
}
