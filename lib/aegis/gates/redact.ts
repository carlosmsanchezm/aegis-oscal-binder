import { sha256Bytes } from "../hash";

const SECRET_KEYS = new Set([
  "token",
  "secret",
  "password",
  "authorization",
  "cookie",
  "credential",
  "apikey",
  "api_key",
  "accesstoken",
  "refreshtoken",
  "session",
  "privatekey",
  "client_secret",
]);

const SECRET_VALUE = /sk-(?:proj-)?[A-Za-z0-9_-]{16,}|aegis_agt_[a-f0-9]{32}_[a-f0-9]{64}|-----BEGIN (?:[A-Z ]*PRIVATE KEY)-----[\s\S]*?-----END (?:[A-Z ]*PRIVATE KEY)-----|LS0tLS1CRUdJTi[A-Za-z0-9+\/=]{40,}|ghp_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,}|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|Bearer\s+\S+|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}/gi;

export function containsSecret(value: string): boolean {
  SECRET_VALUE.lastIndex = 0;
  return SECRET_VALUE.test(value);
}

export function redactText(value: string): string {
  return value.replace(SECRET_VALUE, "[redacted]");
}

export function redactValue(value: unknown): unknown {
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item));
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "__proto__" || key === "prototype" || key === "constructor") continue;
    out[key] = SECRET_KEYS.has(key.toLowerCase()) ? "[redacted]" : redactValue(item);
  }
  return out;
}

export function hashDetail(value: unknown): string {
  return sha256Bytes(stable(redactValue(value)));
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stable(item)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
