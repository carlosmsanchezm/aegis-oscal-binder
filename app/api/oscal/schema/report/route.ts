import { getSspSchemaReport } from "@/lib/server/handlers";
import { withSession } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(req: Request) {
  return withSession(req, () => getSspSchemaReport());
}
