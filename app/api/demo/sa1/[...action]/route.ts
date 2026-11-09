import { sa1Request } from "@/lib/server/sa1-router";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ action: string[] }> };
async function route(req: Request, context: Context) {
  return sa1Request(req, (await context.params).action);
}
export { route as GET, route as POST, route as PATCH };
