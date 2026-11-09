import { IdentityRejected, exchangeCode, isProvider, verifyIdentity } from "@/lib/account/oauth";
import {
  ACCOUNT_COOKIE,
  clearCookie,
  cookieHeader,
  OAUTH_COOKIE,
  openOAuth,
  ORG_COOKIE,
  publicOrigin,
  readCookie,
  requestIsSecure,
  sealAccount,
} from "@/lib/account/session";
import { organizationsFor, upsertIdentity } from "@/lib/account/store";
import { safeReturn } from "@/lib/account/text";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function redirect(location: string, cookies: string[]): Response {
  const headers = new Headers({ location, "cache-control": "private, no-store" });
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(null, { status: 302, headers });
}

export async function GET(req: Request, context: { params: Promise<{ provider: string }> }): Promise<Response> {
  const { provider: raw } = await context.params;
  const url = new URL(req.url);
  const secure = requestIsSecure(req);
  const txn = await openOAuth(readCookie(req.headers.get("cookie"), OAUTH_COOKIE) ?? "");
  const returnTo = safeReturn(txn?.returnTo);
  const cookies = [clearCookie(OAUTH_COOKIE, secure)];
  const fail = (error: string) => redirect(`/sign-in?error=${error}&return=${encodeURIComponent(returnTo)}`, cookies);
  if (!isProvider(raw) || !txn || txn.provider !== raw || url.searchParams.get("state") !== txn.state) return fail("failed");
  if (url.searchParams.get("error") === "access_denied") return fail("cancelled");
  if (url.searchParams.get("error")) return fail("failed");
  const code = url.searchParams.get("code") ?? "";
  if (!code) return fail("failed");
  try {
    const idToken = await exchangeCode(raw, { origin: publicOrigin(req), code, verifier: txn.verifier });
    const identity = await verifyIdentity(raw, idToken, txn.nonce);
    const user = await upsertIdentity(identity);
    const orgs = await organizationsFor(user.id);
    cookies.push(cookieHeader(ACCOUNT_COOKIE, await sealAccount({
      uid: user.id, email: user.email, name: user.name, provider: user.provider,
    }), secure, 8 * 60 * 60));
    if (orgs[0]) cookies.push(cookieHeader(ORG_COOKIE, orgs[0].id, secure, 8 * 60 * 60));
    const destination = orgs.length === 0 && !returnTo.startsWith("/invite/") ? "/sign-in?notice=no-org" : returnTo;
    return redirect(destination, cookies);
  } catch (error) {
    if (error instanceof IdentityRejected) return fail(error.reason === "personal" ? "personal" : error.reason === "unverified" ? "unverified" : "failed");
    return fail("failed");
  }
}
