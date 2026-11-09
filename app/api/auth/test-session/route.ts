import { AegisError } from "@/lib/aegis/errors";
import { assertSameOrigin } from "@/lib/account/access";
import { upsertIdentity } from "@/lib/account/store";
import { ACCOUNT_COOKIE, cookieHeader, requestIsSecure, sealAccount } from "@/lib/account/session";
import { cleanName, normalizeEmail } from "@/lib/account/text";
import { accountHandler, accountJson } from "@/lib/account/route";
import { readJson } from "@/lib/server/http";
import type { Provider } from "@/lib/account/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function enabled(): boolean {
  return process.env.AEGIS_AUTH_TEST === "1" && !process.env.VERCEL;
}

export function POST(req: Request): Promise<Response> {
  if (!enabled()) return Promise.resolve(Response.json({ ok: false, error: { code: "NOT_FOUND", message: "Not found", details: null } }, { status: 404 }));
  return accountHandler(async () => {
    assertSameOrigin(req);
    const body = await readJson(req);
    const email = normalizeEmail(body.email);
    const name = cleanName(body.name, 120);
    const provider: Provider | null = body.provider === "google" || body.provider === "microsoft" ? body.provider : null;
    if (!email || !email.endsWith(".test") || !name || !provider) {
      throw new AegisError("BAD_REQUEST", "The test sign-in needs a .test work email, a name, and a provider.", 400);
    }
    const user = await upsertIdentity({ provider, email, name, subject: `test:${provider}:${email}` });
    const response = accountJson({ user: { id: user.id, email: user.email, name: user.name, provider: user.provider } }, null);
    response.headers.append("set-cookie", cookieHeader(ACCOUNT_COOKIE, await sealAccount({
      uid: user.id, email: user.email, name: user.name, provider: user.provider,
    }), requestIsSecure(req), 8 * 60 * 60));
    return response;
  });
}
