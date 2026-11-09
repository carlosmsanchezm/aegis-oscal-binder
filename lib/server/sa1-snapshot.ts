import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { deflateSync, inflateSync } from "node:zlib";
import { AegisError, type PersistedState } from "@/lib/aegis";

const PREFIX = "aegis_sa1_snapshot_";
const CHUNKS = 3;
const CHUNK_SIZE = 3000;
const TTL = 24 * 60 * 60;
const localKey = randomBytes(32);

function key(): Buffer {
  const configured = process.env.AEGIS_DEMO_COOKIE_KEY;
  if (configured && /^[a-f0-9]{64}$/i.test(configured)) return Buffer.from(configured, "hex");
  if (process.env.NODE_ENV !== "production") return localKey;
  throw new AegisError("DEMO_CONFIGURATION", "Demo session cookie encryption is not configured on this host.", 503);
}

/** Demo-only, authenticated state transport. Not durable agency evidence storage.
 * Bound to the session id and expiry. Do not serialize upload bytes or Office
 * artifacts; OSCAL is reconstructed by the existing serializer when needed.
 * The uploaded SSP, ingest-time control copy and optional map display metadata
 * stay on the durable session. A cookie-only recovery may omit that metadata;
 * the map already renders honest empty states when it is unavailable.
 * The cookie keeps the working controls inside the 3 by 3000 character budget. */
export function encodeSa1Snapshot(state: PersistedState, sid: string, secret = key(), now = Date.now()): string {
  const compact = structuredClone(state);
  compact.exports = compact.exports.slice(-3).map(({ xml: _xml, ...record }) => ({ ...record, filePath: "" }));
  delete compact.sourceSsp;
  delete compact.importBaseline;
  for (const control of compact.controls) {
    delete control.implementedBy;
    delete control.providerCoverage;
  }
  const plaintext = deflateSync(JSON.stringify({ expires: now + TTL * 1000, state: compact }));
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", secret, iv);
  cipher.setAAD(Buffer.from(sid));
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const encoded = Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64url");
  if (encoded.length > CHUNKS * CHUNK_SIZE) throw new AegisError("DEMO_SIZE", "This demo rehearsal package exceeds the demo snapshot size limit. Restart with the demo sample package.", 413);
  return encoded;
}

export function decodeSa1Snapshot(raw: string | null, sid: string, secret = key(), now = Date.now()): PersistedState | null {
  const cookies = new Map((raw ?? "").split(";").map((part) => {
    const at = part.indexOf("=");
    return [part.slice(0, at).trim(), part.slice(at + 1).trim()];
  }));
  const encoded = Array.from({ length: CHUNKS }, (_, i) => cookies.get(`${PREFIX}${i}`) ?? "").join("");
  if (!encoded || encoded.length > CHUNKS * CHUNK_SIZE) return null;
  try {
    const bytes = Buffer.from(encoded, "base64url");
    const decipher = createDecipheriv("aes-256-gcm", secret, bytes.subarray(0, 12));
    decipher.setAAD(Buffer.from(sid));
    decipher.setAuthTag(bytes.subarray(12, 28));
    const plaintext = Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]);
    const decoded = JSON.parse(inflateSync(plaintext, { maxOutputLength: 1_000_000 }).toString("utf8"));
    if (typeof decoded.expires !== "number" || decoded.expires <= now || !decoded.state || decoded.state.version !== 1) return null;
    return decoded.state as PersistedState;
  } catch { return null; }
}

export function sa1SnapshotCookies(encoded: string, secure: boolean): string[] {
  return Array.from({ length: CHUNKS }, (_, i) => {
    const chunk = encoded.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
    return `${PREFIX}${i}=${chunk}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${chunk ? TTL : 0}${secure ? "; Secure" : ""}`;
  });
}
