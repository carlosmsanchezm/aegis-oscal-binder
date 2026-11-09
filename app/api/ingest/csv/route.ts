import { postCsvIngest } from "@/lib/server/handlers";
import { withSession } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(req: Request) {
  return withSession(req, () => postCsvIngest(req));
}
