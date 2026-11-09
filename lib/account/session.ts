import { jwtVerify, SignJWT } from "jose";
import { AegisError } from "@/lib/aegis/errors";
import type { Provider } from "./types";

export const ACCOUNT_COOKIE = "aegis_account";
export const ORG_COOKIE = "aegis_org";
export const OAUTH_COOKIE = "aegis_oauth";
const ISSUER = "oscal-binder";
const ACCOUNT_AUDIENCE = "oscal-binder-account";
const OAUTH_AUDIENCE = "oscal-binder-oauth";

export type AccountSession = {
  uid: string;
  email: string;
  name: string;
  provider: Provider;
};

export type OAuthTxn = {
  provider: Provider;
  state: string;
  nonce: string;
  verifier: string;
  returnTo: string;
};

export function authConfigured(): boolean {
  return secret() !== null;
}

function secret(): Uint8Array | null {
  const value = process.env.AUTH_SECRET?.trim() ?? "";
  if (value.length < 16) return null;
  return new TextEncoder().encode(value);
}

function requireSecret(): Uint8Array {
  const key = secret();
  if (!key) throw new AegisError("AUTH_CONFIGURATION", "AUTH_SECRET is not configured on this deployment.", 503);
  return key;
}

export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    const at = trimmed.indexOf("=");
    if (at <= 0 || trimmed.slice(0, at) !== name) continue;
    const value = trimmed.slice(at + 1);
    return value || null;
  }
  return null;
}

export async function sealAccount(session: AccountSession): Promise<string> {
  return new SignJWT({ email: session.email, name: session.name, provider: session.provider })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(session.uid)
    .setIssuer(ISSUER)
    .setAudience(ACCOUNT_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime("8h")
    .sign(requireSecret());
}

export async function openAccount(token: string): Promise<AccountSession | null> {
  const key = secret();
  if (!key || !token) return null;
  try {
    const { payload } = await jwtVerify(token, key, { issuer: ISSUER, audience: ACCOUNT_AUDIENCE });
    const uid = payload.sub ?? "";
    const email = typeof payload.email === "string" ? payload.email : "";
    const name = typeof payload.name === "string" ? payload.name : "";
    const provider = payload.provider === "google" || payload.provider === "microsoft" ? payload.provider : null;
    if (!/^[0-9a-f-]{36}$/.test(uid) || !email || !provider) return null;
    return { uid, email, name, provider };
  } catch {
    return null;
  }
}

export async function accountFromRequest(req: Request): Promise<AccountSession | null> {
  const token = readCookie(req.headers.get("cookie"), ACCOUNT_COOKIE);
  if (!token) return null;
  return openAccount(decodeURIComponent(token));
}

export async function sealOAuth(txn: OAuthTxn): Promise<string> {
  return new SignJWT({ ...txn })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(ISSUER)
    .setAudience(OAUTH_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(requireSecret());
}

export async function openOAuth(token: string): Promise<OAuthTxn | null> {
  const key = secret();
  if (!key || !token) return null;
  try {
    const { payload } = await jwtVerify(token, key, { issuer: ISSUER, audience: OAUTH_AUDIENCE });
    const provider = payload.provider === "google" || payload.provider === "microsoft" ? payload.provider : null;
    const state = typeof payload.state === "string" ? payload.state : "";
    const nonce = typeof payload.nonce === "string" ? payload.nonce : "";
    const verifier = typeof payload.verifier === "string" ? payload.verifier : "";
    const returnTo = typeof payload.returnTo === "string" ? payload.returnTo : "";
    if (!provider || !state || !nonce || !verifier || !returnTo) return null;
    return { provider, state, nonce, verifier, returnTo };
  } catch {
    return null;
  }
}

export function requestIsSecure(req: Request): boolean {
  const forwarded = req.headers.get("x-forwarded-proto");
  if (forwarded) return forwarded.split(",")[0]?.trim() === "https";
  try {
    return new URL(req.url).protocol === "https:";
  } catch {
    return false;
  }
}

export function publicOrigin(req: Request): string {
  const url = new URL(req.url);
  const forwarded = req.headers.get("x-forwarded-host")?.split(",")[0]?.trim() ?? "";
  const host = req.headers.get("host")?.trim() ?? "";
  const chosen = forwarded || host || url.host;
  if (!/^[A-Za-z0-9.-]+(?::\d+)?$/.test(chosen)) return url.origin;
  const proto = (req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() || url.protocol.replace(":", ""));
  if (proto !== "https" && proto !== "http") return url.origin;
  return `${proto}://${chosen}`;
}

export function cookieHeader(name: string, value: string, secure: boolean, maxAge: number): string {
  const parts = [`${name}=${value}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${maxAge}`];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearCookie(name: string, secure: boolean): string {
  return cookieHeader(name, "", secure, 0);
}
