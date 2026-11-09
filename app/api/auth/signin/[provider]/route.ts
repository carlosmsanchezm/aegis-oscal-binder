import { AegisError } from "@/lib/aegis/errors";
import { authorizeUrl, isProvider, newPkce, providerConfigured } from "@/lib/account/oauth";
import { cookieHeader, OAUTH_COOKIE, publicOrigin, requestIsSecure, sealOAuth } from "@/lib/account/session";
import { authConfigured } from "@/lib/account/session";
import { safeReturn } from "@/lib/account/text";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function redirect(location: string, cookies: string[] = []): Response {
  const headers = new Headers({ location, "cache-control": "private, no-store" });
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(null, { status: 302, headers });
}

export async function GET(req: Request, context: { params: Promise<{ provider: string }> }): Promise<Response> {
  const { provider: raw } = await context.params;
  const returnTo = safeReturn(new URL(req.url).searchParams.get("return"));
  const back = `/sign-in?error=configuration&return=${encodeURIComponent(returnTo)}`;
  if (!isProvider(raw) || !authConfigured() || !providerConfigured(raw)) return redirect(back);
  try {
    const pkce = newPkce();
    const sealed = await sealOAuth({ provider: raw, ...pkce, returnTo });
    const secure = requestIsSecure(req);
    return redirect(authorizeUrl(raw, { origin: publicOrigin(req), state: pkce.state, nonce: pkce.nonce, challenge: pkce.challenge }), [
      cookieHeader(OAUTH_COOKIE, sealed, secure, 600),
    ]);
  } catch (error) {
    if (error instanceof AegisError && error.code === "AUTH_CONFIGURATION") return redirect(back);
    throw error;
  }
}
