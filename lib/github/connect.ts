import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {backendFailureDiagnostic} from "../server/backend-diagnostics";
import { AegisError, getSession } from "@/lib/aegis";
import { accountFromRequest, clearCookie, cookieHeader, readCookie, requestIsSecure } from "@/lib/account/session";
import { jsonError } from "@/lib/server/http";
import { BuilderRequestError, checkBrowserMutation } from "@/lib/server/builder-http";
import { sourceCaptureDocument, type SourceCapture } from "../collector/source-tree";
import {
  assertRef,
  assertRepoName,
  installUrl,
  listInstallationRepos,
  readInstallation,
  readRepo,
  repoUrl,
  scanPinnedRepository,
  verifyWebhook,
  type ConnectedRepo,
} from "./client";
import { GithubConfigError, GithubPermissionError, GithubRejected, GithubRequestError, githubAppConfig, redactSecrets } from "./config";
import {
  consumeInstallNonce,
  connectedRepos,
  findConnectedRepo,
  readCapture,
  rememberInstallNonce,
  saveCapture,
  saveInstallation,
  updateInstallation,
  type InstallationRecord,
} from "./store";

export const GITHUB_STATE_COOKIE = "aegis_github_state";
const STATE_TTL_MS = 10 * 60 * 1000;
const WEBHOOK_BYTES = 1_000_000;

/** Factual limits returned beside a connection. They are not part of the capture document. */
export const githubConnectionLimitations = [
  "Read-only inventory of one pinned commit. Source declarations are not deployed enforcement.",
  "Connecting a repository does not authorize processing agency evidence.",
] as const;

export async function githubOwner(req: Request): Promise<string> {
  const account = await accountFromRequest(req);
  if (account) return `account:${account.uid}`;
  return `session:${getSession().id}`;
}

export function githubErrorResponse(error: unknown): Response {
  if (error instanceof AegisError) return jsonError(error);
  if (error instanceof GithubConfigError) return jsonError(new AegisError("GITHUB_APP_CONFIGURATION", error.message, 503, { missing: error.missing }));
  if (error instanceof GithubPermissionError) return jsonError(new AegisError("GITHUB_PERMISSIONS", redactSecrets(error.message), 403));
  if (error instanceof GithubRequestError) return jsonError(new AegisError("GITHUB_REQUEST", error.message, 502));
  if (error instanceof GithubRejected) return jsonError(new AegisError("GITHUB_REJECTED", redactSecrets(error.message), error.status));
  if (error instanceof BuilderRequestError) return jsonError(new AegisError("CROSS_ORIGIN", error.message, error.status));
  return jsonError(error instanceof Error ? new Error(redactSecrets(error.message)) : error);
}

function repoLabel(repo: ConnectedRepo): string {
  return `${repo.owner}/${repo.name}`;
}

function repoJson(repo: ConnectedRepo, installation: InstallationRecord) {
  return {
    owner: repo.owner,
    name: repo.name,
    private: repo.private,
    installationId: installation.installationId,
    label: repoLabel(repo),
    repo: repoUrl(repo.owner, repo.name),
    suspended: installation.suspended,
    accountLogin: installation.accountLogin,
    connectedAt: installation.connectedAt,
  };
}

export async function startGithubInstall(req: Request): Promise<Response> {
  const config = githubAppConfig();
  const owner = await githubOwner(req);
  const nonce = randomBytes(24).toString("base64url");
  const exp = Date.now() + STATE_TTL_MS;
  const body = Buffer.from(JSON.stringify({ v: 1, nonce, exp })).toString("base64url");
  const sig = createHmac("sha256", config.webhookSecret).update(body).digest("base64url");
  await rememberInstallNonce(nonce, owner, exp);
  const headers = new Headers({ location: installUrl(`${body}.${sig}`), "cache-control": "private, no-store" });
  headers.append("set-cookie", cookieHeader(GITHUB_STATE_COOKIE, nonce, requestIsSecure(req), Math.floor(STATE_TTL_MS / 1000)));
  return new Response(null, { status: 302, headers });
}

export async function finishGithubInstall(req: Request): Promise<Response> {
  const config = githubAppConfig();
  const owner = await githubOwner(req);
  const url = new URL(req.url);
  const secure = requestIsSecure(req);
  const headers = new Headers({ "cache-control": "private, no-store", vary: "cookie" });
  headers.append("set-cookie", clearCookie(GITHUB_STATE_COOKIE, secure));
  try {
    const opened = openState(url.searchParams.get("state") ?? "", readCookie(req.headers.get("cookie"), GITHUB_STATE_COOKIE) ?? "", config.webhookSecret);
    const bound = opened ? await consumeInstallNonce(opened.nonce) : null;
    if (!opened || !bound || bound !== owner) {
      return jsonWith(headers, { ok: false, error: { code: "GITHUB_STATE", message: "Start the GitHub connection again.", details: null } }, 400);
    }
    if (url.searchParams.get("setup_action") === "request") {
      return jsonWith(headers, { ok: true, pending: true, limitations: githubConnectionLimitations }, 202);
    }
    const installationId = Number(url.searchParams.get("installation_id"));
    if (!Number.isSafeInteger(installationId) || installationId <= 0) throw new GithubRejected("GitHub installation id is required.", 400);
    const account = await readInstallation(installationId);
    const repos = await listInstallationRepos(installationId);
    const now = new Date().toISOString();
    const record: InstallationRecord = {
      installationId,
      accountLogin: account.accountLogin,
      accountType: account.accountType,
      repos,
      connectedAt: now,
      updatedAt: now,
      suspended: account.suspended,
    };
    await saveInstallation(owner, record);
    return jsonWith(headers, {
      ok: true,
      installation: { installationId, accountLogin: account.accountLogin, suspended: account.suspended, repos: repos.map((repo) => repoJson(repo, record)) },
      limitations: githubConnectionLimitations,
    });
  } catch (error) {
    const response = githubErrorResponse(error);
    response.headers.append("set-cookie", clearCookie(GITHUB_STATE_COOKIE, secure));
    return response;
  }
}

export async function listGithubRepos(req: Request): Promise<Response> {
  const rows = await connectedRepos(await githubOwner(req));
  let installHref: string | null = null;
  try { installHref = installUrl(); } catch { installHref = null; }
  return Response.json({
    ok: true,
    repos: rows.map((row) => repoJson(row.repo, row.installation)),
    installHref,
    limitations: githubConnectionLimitations,
  }, { headers: { "cache-control": "private, no-store", vary: "cookie" } });
}

export async function scanGithubRepo(req: Request): Promise<Response> {
  checkBrowserMutation(req);
  const body = await readObject(req);
  const repoOwner = typeof body.owner === "string" ? body.owner : "";
  const name = typeof body.repo === "string" ? body.repo : "";
  const ref = typeof body.ref === "string" ? body.ref : "";
  assertRepoName(repoOwner);
  assertRepoName(name);
  assertRef(ref);
  const owner = await githubOwner(req);
  const connected = await findConnectedRepo(owner, repoOwner, name);
  if (!connected) throw new GithubRejected("That repository is not connected to this session.", 404);
  const capturedAt = new Date().toISOString();
  const capture = await scanPinnedRepository({
    installationId: connected.installation.installationId,
    owner: connected.repo.owner,
    repo: connected.repo.name,
    ref,
    capturedAt,
  });
  const id = await saveCapture(owner, capture, connected.installation.installationId);
  return Response.json({
    ok: true,
    capture: captureSummary(id, capture),
    limitations: githubConnectionLimitations,
  }, { headers: { "cache-control": "private, no-store", vary: "cookie" } });
}

export async function fetchGithubCapture(req: Request, id: string): Promise<Response> {
  const document = await readCapture(await githubOwner(req), id);
  if (!document) throw new GithubRejected("Source capture not found.", 404);
  return Response.json(document, { headers: { "cache-control": "private, no-store", vary: "cookie" } });
}

export function captureSummary(id: string, capture: SourceCapture) {
  const facts = capture.artifacts.reduce((count, artifact) => count + artifact.facts.length, 0);
  return {
    id,
    schema: sourceCaptureDocument([capture]).schema,
    href: `/api/github/captures/${id}`,
    source: capture.source,
    artifacts: capture.artifacts.length,
    facts,
    events: capture.events.length,
    excluded: capture.excluded.length,
    label: `${capture.source.repo} @ ${capture.source.commit.slice(0, 12)}`,
    summary: `${capture.artifacts.length} artifacts, ${facts} facts, ${capture.excluded.length} excluded`,
  };
}

export async function receiveGithubWebhook(req: Request, schedule?: (work:()=>Promise<void>)=>void): Promise<Response> {
  const length = Number(req.headers.get("content-length"));
  if (Number.isFinite(length) && length > WEBHOOK_BYTES) throw new GithubRejected("GitHub webhook is too large.", 413);
  const payload = await req.text();
  if (Buffer.byteLength(payload) > WEBHOOK_BYTES) throw new GithubRejected("GitHub webhook is too large.", 413);
  const signature = req.headers.get("x-hub-signature-256") ?? "";
  let valid = false;
  try { valid = await verifyWebhook(payload, signature); } catch (error) {
    if (error instanceof GithubConfigError) throw error;
    valid = false;
  }
  if (!valid) throw new GithubRejected("GitHub webhook signature was rejected.", 401);
  let body: unknown;
  try { body = JSON.parse(payload); } catch { throw new GithubRejected("GitHub webhook body was not JSON.", 400); }
  const event=req.headers.get("x-github-event") ?? "";
  if(schedule&&["pull_request","check_run","check_suite","workflow_run"].includes(event)){
    schedule(async()=>{
      try{await applyWebhook(event,body);}
      catch(error){
        const backend=backendFailureDiagnostic(error);
        console.error("GitHub webhook refresh failed",error instanceof GithubRequestError?{status:error.status,category:"github-request"}:{status:0,category:"refresh-unavailable",...(backend.category!=="backend-unclassified"?{backend}:{})});
      }
    });
    return Response.json({ok:true,processing:"scheduled"},{headers:{"cache-control":"private, no-store"}});
  }
  await applyWebhook(event, body);
  return Response.json({ ok: true }, { headers: { "cache-control": "private, no-store" } });
}

export async function applyWebhook(event: string, body: unknown): Promise<void> {
  if (!body || typeof body !== "object") return;
  await (await import("./pull-requests")).applyPrWebhook(event, body);
  await (await import("./poam-gate")).poamGateWebhook(event, body);
  const payload = body as { action?: unknown; installation?: unknown; repositories?: unknown; repositories_added?: unknown; repositories_removed?: unknown };
  const installation = readWebhookInstallation(payload.installation);
  if (!installation) return;
  const now = new Date().toISOString();
  if (event === "installation" && payload.action === "deleted") {
    await updateInstallation(installation.installationId, () => null);
    return;
  }
  if (event === "installation" && (payload.action === "suspend" || payload.action === "unsuspend")) {
    await updateInstallation(installation.installationId, (current) => current ? { ...current, suspended: payload.action === "suspend", updatedAt: now } : null);
    return;
  }
  if (event === "installation" && payload.action === "created") {
    const repos = readWebhookRepos(payload.repositories);
    await saveInstallation(null, {
      installationId: installation.installationId,
      accountLogin: installation.accountLogin,
      accountType: installation.accountType,
      repos,
      connectedAt: now,
      updatedAt: now,
      suspended: installation.suspended,
    });
    return;
  }
  if (event === "installation_repositories" && (payload.action === "added" || payload.action === "removed")) {
    const added = readWebhookRepos(payload.repositories_added);
    const removed = new Set(readWebhookRepos(payload.repositories_removed).map((repo) => repoLabel(repo).toLowerCase()));
    await updateInstallation(installation.installationId, (current) => {
      if (!current) return null;
      const kept = current.repos.filter((repo) => !removed.has(repoLabel(repo).toLowerCase()));
      const seen = new Set(kept.map((repo) => repoLabel(repo).toLowerCase()));
      for (const repo of added) if (!seen.has(repoLabel(repo).toLowerCase())) kept.push(repo);
      return { ...current, repos: kept, updatedAt: now, suspended: installation.suspended };
    });
  }
}

function readWebhookInstallation(value: unknown): { installationId: number; accountLogin: string; accountType: "Organization" | "User"; suspended: boolean } | null {
  if (!value || typeof value !== "object") return null;
  const installation = value as { id?: unknown; suspended_at?: unknown; account?: { login?: unknown; type?: unknown } };
  const installationId = installation.id;
  const login = installation.account?.login;
  const type = installation.account?.type === "Organization" ? "Organization" : installation.account?.type === "User" ? "User" : null;
  if (typeof installationId !== "number" || !Number.isSafeInteger(installationId) || installationId <= 0) return null;
  if (typeof login !== "string" || !type) return null;
  return { installationId, accountLogin: login, accountType: type, suspended: typeof installation.suspended_at === "string" && installation.suspended_at.length > 0 };
}

function readWebhookRepos(value: unknown): ConnectedRepo[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const repo = item as { name?: string; full_name?: string; private?: boolean; owner?: { login?: string } };
    return readRepo(repo);
  });
}

function openState(state: string, nonce: string, secret: string, now = Date.now()): { nonce: string; exp: number } | null {
  const dot = state.lastIndexOf(".");
  if (dot <= 0 || !nonce) return null;
  const body = state.slice(0, dot);
  const sig = state.slice(dot + 1);
  const expected = createHmac("sha256", secret).update(body).digest("base64url");
  const left = Buffer.from(sig);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); } catch { return null; }
  const record = parsed as { v?: unknown; nonce?: unknown; exp?: unknown };
  if (record.v !== 1 || typeof record.nonce !== "string" || typeof record.exp !== "number" || record.exp < now) return null;
  const stored = Buffer.from(record.nonce);
  const given = Buffer.from(nonce);
  if (stored.length !== given.length || !timingSafeEqual(stored, given)) return null;
  return { nonce: record.nonce, exp: record.exp };
}

async function readObject(req: Request): Promise<Record<string, unknown>> {
  const length = Number(req.headers.get("content-length"));
  if (Number.isFinite(length) && length > 8_000) throw new GithubRejected("Scan request is too large.", 413);
  const text = await req.text();
  if (Buffer.byteLength(text) > 8_000) throw new GithubRejected("Scan request is too large.", 413);
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new GithubRejected("JSON object required.", 400); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new GithubRejected("JSON object required.", 400);
  return parsed as Record<string, unknown>;
}

function jsonWith(headers: Headers, body: unknown, status = 200): Response {
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body), { status, headers });
}
