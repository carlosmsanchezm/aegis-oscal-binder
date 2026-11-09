import {normalizeStatementMapping} from "@/lib/aegis/statement-mapping";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { deflateSync, inflateSync } from "node:zlib";
import { AegisError } from "@/lib/aegis";
import { normalizePlanDecision } from "@/lib/aegis/plan-proposal";
import { normalizeStoredPlan, restoreAssessment } from "@/lib/aegis/remediation";
import type { RemediationRecord } from "@/lib/aegis/remediation-store";

const PREFIX = "aegis_remediation_v2_";
const MAX_VALUE = 3500;
const MAX_AGE = 60 * 60 * 24;
const localKey = randomBytes(32);

function key(): Buffer {
  const configured = process.env.AEGIS_REMEDIATION_COOKIE_KEY;
  if (configured && /^[a-f0-9]{64}$/i.test(configured)) return Buffer.from(configured, "hex");
  if (process.env.NODE_ENV !== "production") return localKey;
  throw new AegisError("SESSION_CONFIGURATION", "Browser-session draft storage is not configured on this host.", 503);
}

function cookieName(recordKey: string): string {
  return `${PREFIX}${createHash("sha256").update(recordKey).digest("hex").slice(0, 24)}`;
}

function secureRequest(req: Request): boolean {
  const forwarded = req.headers.get("x-forwarded-proto");
  return forwarded ? forwarded.split(",")[0]?.trim() === "https" : new URL(req.url).protocol === "https:";
}

function normalizeRecord(value: unknown): RemediationRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Partial<RemediationRecord>;
  if (typeof record.key !== "string" || !record.key.trim() || record.key.length > 2000) return null;
  if (!Array.isArray(record.plans) || record.plans.length > 50) return null;
  const plans = record.plans.map(normalizeStoredPlan);
  if (plans.some((plan) => !plan)) return null;
  const assessment = record.assessment == null ? null : restoreAssessment(record.assessment);
  if (record.assessment != null && !assessment) return null;
  const byItem = record.assessments ?? {};
  if (typeof byItem !== "object" || Array.isArray(byItem) || Object.keys(byItem).length > 100) return null;
  const assessments = Object.fromEntries(Object.entries(byItem).map(([item, value]) => [item, restoreAssessment(value)]));
  if (Object.entries(assessments).some(([item, value]) => item.length > 12000 || !value)) return null;
  const rawProposals = record.proposals ?? [];
  if (!Array.isArray(rawProposals) || rawProposals.length > 50) return null;
  const proposals = rawProposals.map(normalizePlanDecision);
  if (proposals.some((proposal) => !proposal)) return null;
  const rawMappings=record.statementMappings ?? [];
  if(!Array.isArray(rawMappings)||rawMappings.length>200)return null;
  const statementMappings=rawMappings.map(normalizeStatementMapping);
  if(statementMappings.some(m=>!m))return null;
  return { key: record.key, assessment, assessments, plans, proposals,...(record.statementMappings===undefined?{}:{statementMappings}) };
}

/** Authenticated, encrypted transport for internal drafts; never a durable audit record.
 * Legacy unsigned cookies are ignored. A record belongs to one session and one cookie name.
 */
export function readRemediationCookie(header: string | null, sid: string, secret = key(), now = Date.now()): RemediationRecord[] {
  const records: RemediationRecord[] = [];
  for (const part of (header ?? "").split(";")) {
    const at = part.indexOf("=");
    const name = part.slice(0, at).trim();
    const value = part.slice(at + 1).trim();
    if (!name.startsWith(PREFIX) || !value || value.length > MAX_VALUE) continue;
    try {
      const bytes = Buffer.from(value, "base64url");
      const decipher = createDecipheriv("aes-256-gcm", secret, bytes.subarray(0, 12));
      decipher.setAAD(Buffer.from(`${sid}:${name}`));
      decipher.setAuthTag(bytes.subarray(12, 28));
      const plaintext = Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]);
      const parsed = JSON.parse(inflateSync(plaintext, { maxOutputLength: 1_000_000 }).toString("utf8"));
      if (typeof parsed.expires !== "number" || parsed.expires <= now) continue;
      const record = normalizeRecord(parsed.record);
      if (record && cookieName(record.key) === name) records.push(record);
    } catch { /* Invalid, expired, or another session's cookie is not a saved record. */ }
  }
  return records.slice(-20);
}

/** One cookie per record: saving a proposal cannot overwrite another draft's cookie. */
export function remediationSessionCookie(record: RemediationRecord, sid: string, req: Request, secret = key(), now = Date.now()): string {
  const name = cookieName(record.key);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", secret, iv);
  cipher.setAAD(Buffer.from(`${sid}:${name}`));
  const plaintext = deflateSync(JSON.stringify({ expires: now + MAX_AGE * 1000, record }));
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const value = Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64url");
  if (value.length > MAX_VALUE) throw new Error("The draft is too large for this browser session.");
  const secure = secureRequest(req) ? "; Secure" : "";
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE}${secure}`;
}
