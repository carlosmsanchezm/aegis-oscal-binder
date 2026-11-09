import { createPrivateKey } from "node:crypto";

export const GITHUB_APP_ENV = ["GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY", "GITHUB_APP_WEBHOOK_SECRET", "GITHUB_APP_SLUG"] as const;

export type GithubAppEnvName = (typeof GITHUB_APP_ENV)[number];

export type GithubAppConfig = {
  appId: string;
  privateKey: string;
  webhookSecret: string;
  slug: string;
};

export class GithubConfigError extends Error {
  constructor(readonly missing: string[]) {
    super(missing.length ? `GitHub App configuration is incomplete: ${missing.join(", ")}.` : "GitHub App configuration is incomplete.");
    this.name = "GithubConfigError";
  }
}

export class GithubPermissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GithubPermissionError";
  }
}

export class GithubRequestError extends Error {
  constructor(readonly status: number) {
    super(status ? `GitHub request failed with HTTP ${status}.` : "GitHub request failed.");
    this.name = "GithubRequestError";
  }
}

export class GithubRejected extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "GithubRejected";
  }
}

/** Strip credentials that an error or log line might echo. */
export function redactSecrets(value: string): string {
  return value
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, "[redacted]")
    .replace(/\b(ghp|github_pat|gho|ghu|ghs|ghr)_[A-Za-z0-9_]+/g, "[redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._\-]+/gi, "Bearer [redacted]")
    .replace(/\btoken\s+[A-Za-z0-9._\-]+/gi, "token [redacted]");
}

export function missingGithubAppEnv(env: NodeJS.ProcessEnv = process.env): GithubAppEnvName[] {
  return GITHUB_APP_ENV.filter((name) => {
    const value = env[name];
    return typeof value !== "string" || value.trim() === "";
  });
}

/** Accept a PEM block, or the same block stored with escaped newlines. */
export function normalizePrivateKey(value: string): string {
  const trimmed = value.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").trim();
  const pem = trimmed.includes("\n") ? trimmed : trimmed.replace(/\\n/g, "\n");
  if (!pem.includes("-----BEGIN") || !pem.includes("-----END")) throw new GithubConfigError(["GITHUB_APP_PRIVATE_KEY"]);
  const normalized = pem.endsWith("\n") ? pem : `${pem}\n`;
  try {
    createPrivateKey(normalized);
  } catch {
    throw new GithubConfigError(["GITHUB_APP_PRIVATE_KEY"]);
  }
  return normalized;
}

export function githubAppConfig(env: NodeJS.ProcessEnv = process.env): GithubAppConfig {
  const missing = missingGithubAppEnv(env);
  if (missing.length) throw new GithubConfigError(missing);
  const appId = env.GITHUB_APP_ID!.trim();
  const slug = env.GITHUB_APP_SLUG!.trim();
  const webhookSecret = env.GITHUB_APP_WEBHOOK_SECRET!.trim();
  if (!/^\d+$/.test(appId)) throw new GithubConfigError(["GITHUB_APP_ID"]);
  if (!/^[A-Za-z0-9-]+$/.test(slug)) throw new GithubConfigError(["GITHUB_APP_SLUG"]);
  if (webhookSecret.length < 8) throw new GithubConfigError(["GITHUB_APP_WEBHOOK_SECRET"]);
  return { appId, privateKey: normalizePrivateKey(env.GITHUB_APP_PRIVATE_KEY!), webhookSecret, slug };
}

export const silentLog = {
  debug(): void {},
  info(): void {},
  warn(): void {},
  error(): void {},
};
