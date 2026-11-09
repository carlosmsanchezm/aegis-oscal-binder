import { connectionRoute, apiJson } from "@/lib/agent/http";
import { verifyConnectionChains } from "@/lib/agent/verify";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET(req: Request) {
  return connectionRoute(req, async (a) => {
    const result = await verifyConnectionChains(a.connectionId);
    return apiJson(result, result.valid ? 200 : 409);
  });
}
