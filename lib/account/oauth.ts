import { createHash, randomBytes } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { Identity, Provider } from "./types";

const GOOGLE_AUTHORIZE = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const GOOGLE_JWKS = "https://www.googleapis.com/oauth2/v3/certs";
const MICROSOFT_AUTHORIZE = "https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize";
const MICROSOFT_TOKEN = "https://login.microsoftonline.com/organizations/oauth2/v2.0/token";
const MICROSOFT_JWKS = "https://login.microsoftonline.com/organizations/discovery/v2.0/keys";
const MICROSOFT_CONSUMER_TENANT = "9188040d-6c67-4c5b-b112-36a304b66dad";

export class IdentityRejected extends Error {
  constructor(readonly reason: "personal" | "unverified" | "incomplete") {
    super(reason);
  }
}

type Hooks = {
  exchange?: (provider: Provider, body: URLSearchParams) => Promise<string>;
  verify?: (provider: Provider, idToken: string, nonce: string) => Promise<Identity>;
};

let hooks: Hooks | null = null;
let googleKeys: ReturnType<typeof createRemoteJWKSet> | null = null;
let microsoftKeys: ReturnType<typeof createRemoteJWKSet> | null = null;

/** Test double for the token endpoint and id token check. Ignored on Vercel. */
export function setOAuthHooksForTests(next: Hooks | null): void {
  if (process.env.VERCEL) return;
  hooks = next;
}

export function isProvider(value: string): value is Provider {
  return value === "google" || value === "microsoft";
}

export function providerConfigured(provider: Provider): boolean {
  if (provider === "google") return Boolean(process.env.AUTH_GOOGLE_ID?.trim() && process.env.AUTH_GOOGLE_SECRET?.trim());
  return Boolean(process.env.AUTH_MICROSOFT_ID?.trim() && process.env.AUTH_MICROSOFT_SECRET?.trim());
}

export function clientId(provider: Provider): string {
  const value = provider === "google" ? process.env.AUTH_GOOGLE_ID : process.env.AUTH_MICROSOFT_ID;
  return value?.trim() ?? "";
}

function clientSecret(provider: Provider): string {
  const value = provider === "google" ? process.env.AUTH_GOOGLE_SECRET : process.env.AUTH_MICROSOFT_SECRET;
  return value?.trim() ?? "";
}

export function redirectUri(origin: string, provider: Provider): string {
  return `${origin}/api/auth/callback/${provider}`;
}

export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function newPkce(): { verifier: string; challenge: string; state: string; nonce: string } {
  const verifier = randomBytes(32).toString("base64url");
  return {
    verifier,
    challenge: pkceChallenge(verifier),
    state: randomBytes(24).toString("base64url"),
    nonce: randomBytes(24).toString("base64url"),
  };
}

export function authorizeUrl(provider: Provider, input: { origin: string; state: string; nonce: string; challenge: string }): string {
  const params = new URLSearchParams({
    client_id: clientId(provider),
    redirect_uri: redirectUri(input.origin, provider),
    response_type: "code",
    scope: "openid email profile",
    state: input.state,
    nonce: input.nonce,
    code_challenge: input.challenge,
    code_challenge_method: "S256",
    prompt: "select_account",
  });
  if (provider === "google") {
    params.set("hd", "*");
    return `${GOOGLE_AUTHORIZE}?${params.toString()}`;
  }
  return `${MICROSOFT_AUTHORIZE}?${params.toString()}`;
}

function claimString(payload: JWTPayload, name: string): string {
  const value = payload[name];
  return typeof value === "string" ? value.trim() : "";
}

export function acceptGoogleClaims(payload: JWTPayload, nonce: string): Identity {
  const email = claimString(payload, "email").toLowerCase();
  const verified = payload.email_verified === true || payload.email_verified === "true";
  const hd = claimString(payload, "hd");
  const subject = claimString(payload, "sub");
  if (!verified) throw new IdentityRejected("unverified");
  if (!hd || email.endsWith("@gmail.com") || email.endsWith("@googlemail.com")) throw new IdentityRejected("personal");
  if (!subject || !email.includes("@") || claimString(payload, "nonce") !== nonce) throw new IdentityRejected("incomplete");
  const name = claimString(payload, "name") || email;
  return { provider: "google", subject, email, name: name.slice(0, 120) };
}

export function acceptMicrosoftClaims(payload: JWTPayload, nonce: string): Identity {
  const tid = claimString(payload, "tid").toLowerCase();
  const subject = claimString(payload, "sub");
  const email = (claimString(payload, "email") || claimString(payload, "preferred_username")).toLowerCase();
  const issuer = claimString(payload, "iss");
  if (!tid || tid === MICROSOFT_CONSUMER_TENANT) throw new IdentityRejected("personal");
  if (issuer !== `https://login.microsoftonline.com/${tid}/v2.0`) throw new IdentityRejected("incomplete");
  if (!subject || !email.includes("@") || claimString(payload, "nonce") !== nonce) throw new IdentityRejected("incomplete");
  const name = claimString(payload, "name") || email;
  return { provider: "microsoft", subject, email, name: name.slice(0, 120) };
}

export async function exchangeCode(provider: Provider, input: { origin: string; code: string; verifier: string }): Promise<string> {
  const body = new URLSearchParams({
    client_id: clientId(provider),
    client_secret: clientSecret(provider),
    code: input.code,
    redirect_uri: redirectUri(input.origin, provider),
    grant_type: "authorization_code",
    code_verifier: input.verifier,
  });
  if (hooks?.exchange) return hooks.exchange(provider, body);
  const response = await fetch(provider === "google" ? GOOGLE_TOKEN : MICROSOFT_TOKEN, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body,
  });
  const json = await response.json().catch(() => null) as { id_token?: unknown } | null;
  if (!response.ok || !json || typeof json.id_token !== "string") throw new IdentityRejected("incomplete");
  return json.id_token;
}

export async function verifyIdentity(provider: Provider, idToken: string, nonce: string): Promise<Identity> {
  if (hooks?.verify) return hooks.verify(provider, idToken, nonce);
  if (provider === "google") {
    googleKeys ??= createRemoteJWKSet(new URL(GOOGLE_JWKS));
    const { payload } = await jwtVerify(idToken, googleKeys, {
      audience: clientId(provider),
      issuer: ["https://accounts.google.com", "accounts.google.com"],
      clockTolerance: 60,
    });
    return acceptGoogleClaims(payload, nonce);
  }
  microsoftKeys ??= createRemoteJWKSet(new URL(MICROSOFT_JWKS));
  const { payload } = await jwtVerify(idToken, microsoftKeys, { audience: clientId(provider), clockTolerance: 60 });
  return acceptMicrosoftClaims(payload, nonce);
}
