import { AegisError } from "@/lib/aegis/errors";
import { safeReturn } from "./text";
import { accountFromRequest } from "./session";
import { readBuilderClaim, readSessionClaim, roleForBuilder, roleForSession } from "./store";
import { canWriteBoundary } from "./types";

const SESSION_ID = /^[a-f0-9]{32}$/;
const BUILDER_OWNER = /^[a-f0-9]{64}$/;
/** Same cookie name as `BUILDER_COOKIE` in the connection store. */
const BUILDER_COOKIE_NAME = "aegis_builder_owner";

function builderSecret(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    if (!trimmed.startsWith(`${BUILDER_COOKIE_NAME}=`)) continue;
    const value = trimmed.slice(BUILDER_COOKIE_NAME.length + 1);
    return BUILDER_OWNER.test(value) ? value : null;
  }
  return null;
}

function sessionId(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    if (!trimmed.startsWith(`${name}=`)) continue;
    const value = trimmed.slice(name.length + 1);
    return SESSION_ID.test(value) ? value : null;
  }
  return null;
}

export function boundaryCookies(header: string | null) {
  return {
    planningSessionId: sessionId(header, "aegis_sa1_sid"),
    packageSessionId: sessionId(header, "aegis_sid"),
    builderOwner: builderSecret(header),
  };
}

/**
 * Claimed planning and package sessions require a member account.
 * A session with no claim keeps the existing cookie behavior.
 */
export async function boundaryDenial(req: Request, sessionId: string): Promise<AegisError | null> {
  if (!SESSION_ID.test(sessionId)) return null;
  const claim = await readSessionClaim(sessionId);
  if (!claim) return null;
  const account = await accountFromRequest(req);
  if (!account) return new AegisError("SIGN_IN_REQUIRED", "This boundary belongs to a workspace. Sign in with a member account.", 401);
  const role = await roleForSession(sessionId, account.uid);
  if (!role) return new AegisError("FORBIDDEN", "This account is not a member of the workspace that owns this boundary.", 403);
  if (req.method !== "GET" && req.method !== "HEAD" && !canWriteBoundary(role)) {
    return new AegisError("FORBIDDEN", `${role === "viewer" ? "A viewer" : "An assessor"} can read this boundary. This role cannot change it.`, 403);
  }
  return null;
}

export async function builderMutationDenial(req: Request): Promise<{ status: number; message: string } | null> {
  const owner = builderSecret(req.headers.get("cookie"));
  if (!owner) return null;
  const claim = await readBuilderClaim(owner);
  if (!claim) return null;
  const account = await accountFromRequest(req);
  if (!account) return { status: 401, message: "This connection belongs to a workspace. Sign in to change it." };
  const role = await roleForBuilder(owner, account.uid);
  if (!role) return { status: 403, message: "This account cannot change this connection." };
  if (!canWriteBoundary(role)) return { status: 403, message: "This role can view the connection. It cannot change it." };
  return null;
}

export function assertSameOrigin(req: Request): void {
  if (req.headers.get("sec-fetch-site") === "cross-site") {
    throw new AegisError("FORBIDDEN", "Cross-origin changes are not allowed.", 403);
  }
  const origin = req.headers.get("origin");
  if (!origin) return;
  let supplied: URL;
  try { supplied = new URL(origin); } catch { throw new AegisError("FORBIDDEN", "Cross-origin changes are not allowed.", 403); }
  const host = req.headers.get("host") ?? new URL(req.url).host;
  if (!["http:", "https:"].includes(supplied.protocol) || supplied.host !== host) {
    throw new AegisError("FORBIDDEN", "Cross-origin changes are not allowed.", 403);
  }
}

export function returnPath(req: Request): string {
  return safeReturn(new URL(req.url).searchParams.get("return"));
}

export function claimedBuilderCookieName(): string {
  return BUILDER_COOKIE_NAME;
}
