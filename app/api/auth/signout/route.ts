import { accountHandler } from "@/lib/account/route";
import { assertSameOrigin } from "@/lib/account/access";
import { ACCOUNT_COOKIE, clearCookie, ORG_COOKIE, requestIsSecure } from "@/lib/account/session";
import { endSession, readSessionId, SESSION_COOKIE } from "@/lib/aegis/store";
import { jsonOk } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(req: Request): Promise<Response> {
  return accountHandler(async () => {
    assertSameOrigin(req);
    await endSession(readSessionId(req.headers.get("cookie")));
    const secure = requestIsSecure(req);
    const response = jsonOk({});
    response.headers.append("set-cookie", clearCookie(ACCOUNT_COOKIE, secure));
    response.headers.append("set-cookie", clearCookie(ORG_COOKIE, secure));
    response.headers.append("set-cookie", clearCookie(SESSION_COOKIE, secure));
    return response;
  });
}
