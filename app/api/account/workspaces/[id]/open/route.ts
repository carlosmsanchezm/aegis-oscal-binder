import { SA1_COOKIE } from "@/lib/aegis/sa1-demo";
import { sessionCookie } from "@/lib/aegis/store";
import { assertSameOrigin } from "@/lib/account/access";
import { accountHandler, accountJson, requireOrg, requireUser } from "@/lib/account/route";
import { requestIsSecure } from "@/lib/account/session";
import { openBoundary, publicWorkspace } from "@/lib/account/store";
import { BUILDER_COOKIE } from "@/lib/server/builder-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(req: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  return accountHandler(async () => {
    assertSameOrigin(req);
    const { user } = await requireUser(req);
    const { org } = await requireOrg(req, user.id);
    const { id } = await context.params;
    const workspace = await openBoundary(org.id, id, user.id);
    const secure = requestIsSecure(req);
    const response = accountJson({ workspace: publicWorkspace(workspace), href: "/planning" }, org);
    response.headers.append("set-cookie", sessionCookie(workspace.packageSessionId, secure));
    response.headers.append("set-cookie", sessionCookie(workspace.planningSessionId, secure).replace("aegis_sid=", `${SA1_COOKIE}=`));
    const builder = [`${BUILDER_COOKIE}=${workspace.builderOwner}`, "Path=/", "HttpOnly", "SameSite=Strict", "Max-Age=2592000"];
    if (secure) builder.push("Secure");
    response.headers.append("set-cookie", builder.join("; "));
    return response;
  });
}
