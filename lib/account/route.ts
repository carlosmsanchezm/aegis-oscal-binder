import { AegisError } from "@/lib/aegis/errors";
import { jsonError, jsonOk } from "@/lib/server/http";
import { assertNoSecrets, getUser, organizationsFor } from "./store";
import { accountFromRequest, ORG_COOKIE, readCookie, type AccountSession } from "./session";
import type { OrgRecord, Role, UserRecord } from "./types";

export async function accountHandler(run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof AegisError) return jsonError(error);
    if (error instanceof Error && (error.message === "Durable storage is not configured." || error.message.startsWith("Durable ") || error.message === "Preview cannot use the production Blob store.")) {
      return jsonError(new AegisError("STORE_UNAVAILABLE", "Account storage is temporarily unavailable.", 503));
    }
    console.error(error);
    return jsonError(error);
  }
}

export function accountJson(body: Record<string, unknown>, org: OrgRecord | null, status = 200): Response {
  assertNoSecrets({ ok: true, ...body }, org);
  return jsonOk(body, status);
}

export async function requireUser(req: Request): Promise<{ session: AccountSession; user: UserRecord }> {
  const session = await accountFromRequest(req);
  if (!session) throw new AegisError("SIGN_IN_REQUIRED", "Sign in with your work account.", 401);
  const user = await getUser(session.uid);
  if (!user || user.email !== session.email) throw new AegisError("SIGN_IN_REQUIRED", "Sign in with your work account.", 401);
  return { session, user };
}

export async function requireOrg(req: Request, userId: string): Promise<{ org: OrgRecord; role: Role; orgs: OrgRecord[] }> {
  const orgs = await organizationsFor(userId);
  if (!orgs.length) throw new AegisError("NO_ORGANIZATION", "This account is not in an organization.", 404);
  const requested = readCookie(req.headers.get("cookie"), ORG_COOKIE);
  const org = orgs.find((item) => item.id === requested) ?? orgs[0]!;
  const role = org.members.find((member) => member.userId === userId)?.role;
  if (!role) throw new AegisError("FORBIDDEN", "This account is not a member of that organization.", 403);
  return { org, role, orgs };
}
