import assert from "node:assert/strict";
import { createHmac, generateKeyPairSync } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { indexedSourceTree, localSourceTree, sourceCapture, walkSourceTree } from "../lib/collector/source-tree";
import { githubAppConfig } from "../lib/github/config";
import { assertReadOnlyPermissions } from "../lib/github/permissions";
import { withPrInstallation } from "../lib/github/auth";
import { readPrSnapshot, readPrSnapshots } from "../lib/github/pull-requests";
import { scanPinnedRepository } from "../lib/github/client";
import { GET as install } from "../app/api/github/install/route";
import { GET as callback } from "../app/api/github/install/callback/route";
import { GET as repos } from "../app/api/github/repos/route";
import { POST as scans } from "../app/api/github/scans/route";
import { GET as captureRoute } from "../app/api/github/captures/[id]/route";
import { POST as webhook } from "../app/api/github/webhook/route";

const TOKEN = "ghs_LEAKMARKER_DO_NOT_STORE";
let previousEnv: Record<string, string | undefined> = {};
const SECRET = "webhook-secret-value";
const SLUG = "aegis-source-collector";
const REPO_URL = "https://github.com/acme/widget";
const CAPTURED = "2026-10-25T05:43:00.000Z";
const SESSION_A = "a".repeat(32);
const SESSION_B = "b".repeat(32);
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs1", format: "pem" }).toString();

const skipped = new Set([".git", "node_modules", "vendor", ".venv", ".next", "dist"]);
const root = mkdtempSync(path.join(tmpdir(), "github-scan-"));
const repoDir = path.join(root, "repo");
const dataDir = path.join(root, "data");
const calls = { tokens: [] as { permissions?: Record<string, string>; repositories?: string[] }[], blobs: [] as string[], trees: [] as string[], commits: 0, revokes: 0 };
const unexpected: string[] = [];
const state = {
  installationPermissions: { contents: "read", metadata: "read" } as Record<string, string>,
  tokenPermissions: null as Record<string, string> | null,
  truncate: false,
  blobStatus: 200,
  commit: "",
  tree: [] as { path: string; mode: string; type: string; sha: string; size?: number }[],
  blobs: new Map<string, Buffer>(),
  forbidden: new Set<string>(),
};

function sign(payload: string): string {
  return `sha256=${createHmac("sha256", SECRET).update(payload).digest("hex")}`;
}

function storedText(): string {
  const read = (dir: string): string => {
    let out = "";
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      out += entry.isDirectory() ? read(file) : readFileSync(file);
    }
    return out;
  };
  try { return read(dataDir); } catch { return ""; }
}

function assertNoSecret(value: string): void {
  assert.equal(value.includes(TOKEN), false);
  assert.equal(value.includes("PRIVATE KEY"), false);
  assert.equal(value.includes(PEM.slice(40, 80)), false);
}

const server = setupServer(
  http.post("https://api.github.com/app/installations/:id/access_tokens", async ({ request }) => {
    const body = await request.json() as { permissions?: Record<string, string>; repositories?: string[] };
    calls.tokens.push({ permissions: body.permissions, repositories: body.repositories });
    return HttpResponse.json({
      token: TOKEN,
      expires_at: "2026-10-25T06:43:00Z",
      permissions: state.tokenPermissions ?? body.permissions,
      repository_selection: body.repositories ? "selected" : "all",
    });
  }),
  http.delete("https://api.github.com/installation/token", () => {
    calls.revokes += 1;
    return new HttpResponse(null, { status: 204 });
  }),
  http.get("https://api.github.com/app/installations/:id", () => HttpResponse.json({
    id: 42,
    account: { login: "acme", type: "Organization" },
    suspended_at: null,
    permissions: state.installationPermissions,
  })),
  http.get("https://api.github.com/installation/repositories", () => HttpResponse.json({
    total_count: 1,
    repositories: [{ id: 7, name: "widget", full_name: "acme/widget", private: false, owner: { login: "acme" } }],
  })),
  http.get("https://api.github.com/repos/:owner/:repo/commits/:ref", () => {
    calls.commits += 1;
    return HttpResponse.json({ sha: state.commit });
  }),
  http.get("https://api.github.com/repos/:owner/:repo/git/trees/:sha", ({ request, params }) => {
    const recursive = new URL(request.url).searchParams.has("recursive");
    calls.trees.push(`${params.sha}:${recursive ? "recursive" : "page"}`);
    if (state.truncate) {
      if (recursive) return HttpResponse.json({ truncated: true, tree: [{ path: "missing.txt", mode: "100644", type: "blob", sha: "missing", size: 4 }] });
      if (params.sha === state.commit) return HttpResponse.json({ truncated: false, tree: [
        { path: "deploy", mode: "040000", type: "tree", sha: "dirsha" },
        { path: "link", mode: "120000", type: "blob", sha: "linksha", size: 10 },
        { path: "deps", mode: "160000", type: "commit", sha: "sub" },
      ] });
      if (params.sha === "dirsha") return HttpResponse.json({ truncated: false, tree: [
        { path: "Dockerfile", mode: "100644", type: "blob", sha: "docker", size: state.blobs.get("docker")?.length ?? 0 },
        { path: "wide.bin", mode: "100644", type: "blob", sha: "wide", size: 2_000_001 },
      ] });
    }
    return HttpResponse.json({ truncated: false, tree: state.tree });
  }),
  http.get("https://api.github.com/repos/:owner/:repo/git/blobs/:sha", ({ params }) => {
    const sha = String(params.sha);
    calls.blobs.push(sha);
    if (state.blobStatus !== 200) return HttpResponse.json({ message: TOKEN }, { status: state.blobStatus });
    if (state.forbidden.has(sha)) return HttpResponse.json({ message: TOKEN }, { status: 500 });
    const bytes = state.blobs.get(sha);
    if (!bytes) return HttpResponse.json({ message: "missing blob" }, { status: 404 });
    return new HttpResponse(bytes, { headers: { "content-type": "application/vnd.github.raw" } });
  }),
);

function resetCalls(): void {
  calls.tokens.length = 0;
  calls.blobs.length = 0;
  calls.trees.length = 0;
  calls.commits = 0;
  calls.revokes = 0;
  unexpected.length = 0;
  state.tokenPermissions = null;
  state.installationPermissions = { contents: "read", metadata: "read" };
  state.truncate = false;
  state.blobStatus = 200;
}

function cookieHeader(response: Response, extra = ""): string {
  const set = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [response.headers.get("set-cookie") ?? ""];
  const pairs = set.map((value) => value.split(";")[0]).filter((value) => value.includes("="));
  return [extra, ...pairs].filter(Boolean).join("; ");
}

async function connect(session = SESSION_A): Promise<{ cookie: string; body: { installation: { repos: { label: string }[] } } }> {
  const started = await install(new Request("http://127.0.0.1/api/github/install", { headers: { cookie: `aegis_sid=${session}` } }));
  assert.equal(started.status, 302);
  const location = new URL(started.headers.get("location") ?? "");
  assert.equal(location.origin + location.pathname, `https://github.com/apps/${SLUG}/installations/new`);
  const cookie = cookieHeader(started, `aegis_sid=${session}`);
  const finished = await callback(new Request(`http://127.0.0.1/api/github/install/callback?installation_id=42&setup_action=install&state=${encodeURIComponent(location.searchParams.get("state") ?? "")}`, { headers: { cookie } }));
  const body = await finished.json() as { installation: { repos: { label: string }[] } };
  assert.equal(finished.status, 200, JSON.stringify(body));
  assert.equal(body.installation.repos[0]?.label, "acme/widget");
  return { cookie: `aegis_sid=${session}`, body };
}

describe("github source scan", { concurrency: false }, () => {
test.before(() => {
  mkdirSync(repoDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(path.join(repoDir, "Dockerfile"), "FROM alpine:3.21\nUSER app\n");
  writeFileSync(path.join(repoDir, "README.md"), Buffer.from([0xff, 0xfe, 0xfd]));
  writeFileSync(path.join(repoDir, "notes.txt"), "plain notes\n");
  writeFileSync(path.join(repoDir, "data.bin"), Buffer.from("a\0b"));
  mkdirSync(path.join(repoDir, ".github", "workflows"), { recursive: true });
  writeFileSync(path.join(repoDir, ".github", "workflows", "ci.yml"), "name: ci\njobs:\n  test:\n    steps:\n      - run: go test ./...\n");
  mkdirSync(path.join(repoDir, "docs"), { recursive: true });
  writeFileSync(path.join(repoDir, "docs", "guide.md"), "Architecture: services communicate over gRPC.\n");
  mkdirSync(path.join(repoDir, "node_modules", "left-pad"), { recursive: true });
  writeFileSync(path.join(repoDir, "node_modules", "left-pad", "index.js"), "module.exports = 1;\n");
  mkdirSync(path.join(repoDir, "vendor"), { recursive: true });
  writeFileSync(path.join(repoDir, "vendor", "lib.go"), "package lib\n");
  symlinkSync("Dockerfile", path.join(repoDir, "link"));
  writeFileSync(path.join(repoDir, "big.bin"), Buffer.alloc(2_000_001, 1));
  const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
  git(["init", "-q"]);
  git(["add", "-A"]);
  git(["-c", "user.name=Collector Test", "-c", "user.email=collector@example.invalid", "commit", "-qm", "Pinned test source"]);
  state.commit = git(["rev-parse", "HEAD"]).trim();
  const listing = git(["ls-tree", "-r", "-t", "-l", "HEAD"]).trim().split("\n").filter(Boolean);
  for (const line of listing) {
    const tab = line.indexOf("\t");
    const [mode, type, sha, size] = line.slice(0, tab).trim().split(/\s+/);
    const file = line.slice(tab + 1);
    const item: { path: string; mode: string; type: string; sha: string; size?: number } = { path: file, mode, type, sha };
    if (size !== "-") item.size = Number(size);
    state.tree.push(item);
    const blocked = mode === "120000" || file.split("/").some((part) => skipped.has(part)) || (item.size ?? 0) > 2_000_000;
    if (blocked) state.forbidden.add(sha);
    else if (type === "blob") state.blobs.set(sha, readFileSync(path.join(repoDir, file)));
  }
  state.blobs.set("docker", Buffer.from("FROM alpine:3.21\nUSER app\n"));
  previousEnv = {
    GITHUB_APP_ID: process.env.GITHUB_APP_ID,
    GITHUB_APP_PRIVATE_KEY: process.env.GITHUB_APP_PRIVATE_KEY,
    GITHUB_APP_WEBHOOK_SECRET: process.env.GITHUB_APP_WEBHOOK_SECRET,
    GITHUB_APP_SLUG: process.env.GITHUB_APP_SLUG,
    AEGIS_DATA_DIR: process.env.AEGIS_DATA_DIR,
  };
  process.env.GITHUB_APP_ID = "12345";
  process.env.GITHUB_APP_PRIVATE_KEY = PEM;
  process.env.GITHUB_APP_WEBHOOK_SECRET = SECRET;
  process.env.GITHUB_APP_SLUG = SLUG;
  process.env.AEGIS_DATA_DIR = dataDir;
  server.listen({ onUnhandledRequest(request) {
    const url = new URL(request.url);
    if (url.hostname === "api.github.com") unexpected.push(`${request.method} ${url.pathname}`);
  } });
});

test.after(() => {
  server.close();
  for (const [name, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

test.beforeEach(() => { resetCalls(); });

test("read-only permission check rejects write and accepts actions read", () => {
  assert.doesNotThrow(() => assertReadOnlyPermissions({ contents: "read", metadata: "read", actions: "read" }, ["contents", "metadata"]));
  assert.throws(() => assertReadOnlyPermissions({ contents: "write", metadata: "read" }, ["contents", "metadata"]), /not a read-only scope/);
  assert.throws(() => assertReadOnlyPermissions({ metadata: "read" }, ["contents", "metadata"]), /contents/);
});

test("private key newlines in the environment are accepted and missing names are listed", () => {
  const previous = process.env.GITHUB_APP_PRIVATE_KEY;
  process.env.GITHUB_APP_PRIVATE_KEY = PEM.replace(/\n/g, "\\n");
  assert.equal(githubAppConfig().appId, "12345");
  delete process.env.GITHUB_APP_SLUG;
  assert.throws(() => githubAppConfig(), /GITHUB_APP_SLUG/);
  process.env.GITHUB_APP_SLUG = SLUG;
  process.env.GITHUB_APP_PRIVATE_KEY = previous;
});

test("GitHub scan matches the local collector for the same commit", async () => {
  const logs: string[] = [];
  const methods = ["log", "info", "warn", "error", "debug"] as const;
  const originals = Object.fromEntries(methods.map((name) => [name, console[name]])) as Record<(typeof methods)[number], (...args: unknown[]) => void>;
  for (const name of methods) console[name] = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
  try {
    const out = path.join(root, "cli-out");
    const config = path.join(root, "sources.json");
    writeFileSync(config, JSON.stringify({ sources: [{ directory: repoDir, repo: REPO_URL, commit: state.commit, capturedAt: CAPTURED }] }));
    execFileSync(process.execPath, ["--import", "tsx", "scripts/collect-evidence.ts", config, out], { cwd: process.cwd(), encoding: "utf8" });
    const local = JSON.parse(readFileSync(path.join(out, "capture.json"), "utf8")).captures[0];
    const scanned = await scanPinnedRepository({ installationId: 42, owner: "acme", repo: "widget", ref: "main", capturedAt: CAPTURED });
    assert.deepEqual(scanned.artifacts, local.artifacts);
    assert.deepEqual(scanned.events, local.events);
    assert.deepEqual(local.excluded.filter((item: { path: string }) => item.path === ".git"), [{ path: ".git", reason: "Dependency, build or Git metadata directory" }]);
    assert.deepEqual(scanned.excluded, local.excluded.filter((item: { path: string }) => item.path !== ".git"));
    assert.equal(scanned.source.commit, state.commit);
    assert.ok(scanned.excluded.some((item) => item.path === "README.md" && item.reason.includes("encoding")));
    assert.ok(scanned.excluded.some((item) => item.path === "data.bin" && item.reason === "Binary source"));
    assert.ok(scanned.excluded.some((item) => item.path === "notes.txt" && item.reason.includes("No supported evidence")));
    assert.ok(scanned.excluded.some((item) => item.path === "big.bin" && item.reason.includes("2 MB")));
    assert.ok(scanned.excluded.some((item) => item.path === "link" && item.reason.includes("Symlink")));
    assert.ok(scanned.excluded.some((item) => item.path === "node_modules" && item.reason.includes("Dependency")));
    assert.ok(scanned.excluded.some((item) => item.path === "vendor" && item.reason.includes("Dependency")));
    assert.equal(calls.blobs.some((sha) => state.forbidden.has(sha)), false);
    const scanToken = calls.tokens.at(-1);
    assert.deepEqual(scanToken?.permissions, { contents: "read", metadata: "read" });
    assert.deepEqual(scanToken?.repositories, ["widget"]);
    assert.equal(JSON.stringify(scanToken).includes("write"), false);
    assert.equal(calls.revokes > 0, true);
    assertNoSecret(JSON.stringify(scanned));
    assertNoSecret(storedText());
    assertNoSecret(logs.join("\n"));
    assert.deepEqual(unexpected, []);
  } finally {
    for (const name of methods) console[name] = originals[name];
  }
});

test("routes keep a capture on the owning session and refuse write scopes", async () => {
  const connected = await connect(SESSION_A);
  assert.equal(calls.tokens.some((token) => JSON.stringify(token.permissions).includes("write")), false);
  assert.deepEqual(calls.tokens[0]?.permissions, { metadata: "read" });
  assert.equal(calls.tokens[0]?.repositories, undefined);
  const listed = await (await repos(new Request("http://127.0.0.1/api/github/repos", { headers: { cookie: connected.cookie } }))).json() as { repos: { label: string }[]; limitations: string[] };
  assert.deepEqual(listed.repos.map((item) => item.label), ["acme/widget"]);
  assert.ok(listed.limitations.some((line) => line.includes("does not authorize processing agency evidence")));
  const other = await (await repos(new Request("http://127.0.0.1/api/github/repos", { headers: { cookie: `aegis_sid=${SESSION_B}` } }))).json() as { repos: unknown[] };
  assert.deepEqual(other.repos, []);
  const blocked = await scans(new Request("http://127.0.0.1/api/github/scans", { method: "POST", headers: { cookie: connected.cookie, origin: "http://evil.example", "content-type": "application/json" }, body: JSON.stringify({ owner: "acme", repo: "widget", ref: "main" }) }));
  assert.equal(blocked.status, 403);
  const badRef = await scans(new Request("http://127.0.0.1/api/github/scans", { method: "POST", headers: { cookie: connected.cookie, "content-type": "application/json" }, body: JSON.stringify({ owner: "acme", repo: "widget", ref: "../main" }) }));
  assert.equal(badRef.status, 400);
  assert.equal(calls.commits, 0);
  resetCalls();
  const scanned = await scans(new Request("http://127.0.0.1/api/github/scans", { method: "POST", headers: { cookie: connected.cookie, "content-type": "application/json" }, body: JSON.stringify({ owner: "acme", repo: "widget", ref: "main" }) }));
  const scanBody = await scanned.json() as { ok: boolean; capture: { id: string; source: { commit: string; capturedAt: string }; summary: string } };
  assert.equal(scanned.status, 200);
  assert.equal(scanBody.capture.source.commit, state.commit);
  assert.match(scanBody.capture.summary, /artifacts/);
  const document = await (await captureRoute(new Request(`http://127.0.0.1/api/github/captures/${scanBody.capture.id}`, { headers: { cookie: connected.cookie } }), { params: Promise.resolve({ id: scanBody.capture.id }) })).json() as { schema: string; captures: { artifacts: unknown; excluded: { path: string }[] }[] };
  assert.equal(document.schema, "aegis.source-capture.v1");
  const hidden = await captureRoute(new Request(`http://127.0.0.1/api/github/captures/${scanBody.capture.id}`, { headers: { cookie: `aegis_sid=${SESSION_B}` } }), { params: Promise.resolve({ id: scanBody.capture.id }) });
  assert.equal(hidden.status, 404);
  const walked = await walkSourceTree(localSourceTree(repoDir), { repo: REPO_URL, commit: scanBody.capture.source.commit, capturedAt: scanBody.capture.source.capturedAt });
  const local = sourceCapture(walked.files, walked.excluded, { repo: REPO_URL, commit: scanBody.capture.source.commit, capturedAt: scanBody.capture.source.capturedAt });
  assert.deepEqual(document.captures[0]?.artifacts, local.artifacts);
  assert.deepEqual(document.captures[0]?.excluded, local.excluded.filter((item) => item.path !== ".git"));
  assertNoSecret(JSON.stringify(document));
  assertNoSecret(storedText());
  assertNoSecret(await hidden.text());
  state.tokenPermissions = { contents: "write", metadata: "read" };
  const beforeTrees = calls.trees.length;
  const refused = await scans(new Request("http://127.0.0.1/api/github/scans", { method: "POST", headers: { cookie: connected.cookie, "content-type": "application/json" }, body: JSON.stringify({ owner: "acme", repo: "widget", ref: "main" }) }));
  const refusedBody = await refused.text();
  assert.equal(refused.status, 403);
  assert.equal(calls.trees.length, beforeTrees);
  assert.equal(calls.revokes > 0, true);
  assertNoSecret(refusedBody);
  assertNoSecret(storedText());
  assert.deepEqual(unexpected, []);
});

test("a write permission on the installation is refused before a token is minted", async () => {
  state.installationPermissions = { contents: "write", metadata: "read" };
  const started = await install(new Request("http://127.0.0.1/api/github/install", { headers: { cookie: `aegis_sid=${"c".repeat(32)}` } }));
  const location = new URL(started.headers.get("location") ?? "");
  const finished = await callback(new Request(`http://127.0.0.1/api/github/install/callback?installation_id=42&setup_action=install&state=${encodeURIComponent(location.searchParams.get("state") ?? "")}`, { headers: { cookie: cookieHeader(started, `aegis_sid=${"c".repeat(32)}`) } }));
  assert.equal(finished.status, 403);
  assert.equal(calls.tokens.length, 0);
  assertNoSecret(await finished.text());
  assertNoSecret(storedText());
});

test("blob errors do not keep the installation token", async () => {
  state.blobStatus = 500;
  const logs: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
  try {
    await assert.rejects(scanPinnedRepository({ installationId: 42, owner: "acme", repo: "widget", ref: "main", capturedAt: CAPTURED }), /HTTP 500/);
    assertNoSecret(logs.join("\n"));
    assertNoSecret(storedText());
    assert.equal(calls.revokes > 0, true);
  } finally { console.error = original; }
});

test("a truncated tree is reread per directory and still skips links, submodules, and oversized files", async () => {
  state.truncate = true;
  const scanned = await scanPinnedRepository({ installationId: 42, owner: "acme", repo: "widget", ref: "main", capturedAt: CAPTURED });
  assert.equal(scanned.artifacts.some((artifact) => artifact.source.path === "deploy/Dockerfile"), true);
  assert.equal(calls.blobs.includes("linksha"), false);
  assert.equal(calls.blobs.includes("wide"), false);
  assert.ok(scanned.excluded.some((item) => item.path === "link"));
  assert.ok(scanned.excluded.some((item) => item.path === "deps" && item.reason.includes("submodule")));
  assert.ok(scanned.excluded.some((item) => item.path === "deploy/wide.bin" && item.reason.includes("2 MB")));
  assert.equal(calls.trees.some((call) => call.endsWith(":page")), true);
});

test("webhook signature gates repository membership changes", async () => {
  const { cookie } = await connect(SESSION_A);
  const added = JSON.stringify({ action: "added", installation: { id: 42, account: { login: "acme", type: "Organization" } }, repositories_added: [{ name: "other", full_name: "acme/other", private: true }], repositories_removed: [] });
  const rejected = await webhook(new Request("http://127.0.0.1/api/github/webhook", { method: "POST", headers: { "x-github-event": "installation_repositories", "x-hub-signature-256": "sha256=00", "content-type": "application/json" }, body: added }));
  assert.equal(rejected.status, 401);
  const accepted = await webhook(new Request("http://127.0.0.1/api/github/webhook", { method: "POST", headers: { "x-github-event": "installation_repositories", "x-hub-signature-256": sign(added), "content-type": "application/json" }, body: added }));
  assert.equal(accepted.status, 200);
  const listed = await (await repos(new Request("http://127.0.0.1/api/github/repos", { headers: { cookie } }))).json() as { repos: { label: string }[] };
  assert.deepEqual(listed.repos.map((item) => item.label).sort(), ["acme/other", "acme/widget"]);
  const removed = JSON.stringify({ action: "removed", installation: { id: 42, account: { login: "acme", type: "Organization" } }, repositories_added: [], repositories_removed: [{ name: "widget", full_name: "acme/widget", private: false }] });
  assert.equal((await webhook(new Request("http://127.0.0.1/api/github/webhook", { method: "POST", headers: { "x-github-event": "installation_repositories", "x-hub-signature-256": sign(removed), "content-type": "application/json" }, body: removed }))).status, 200);
  const after = await (await repos(new Request("http://127.0.0.1/api/github/repos", { headers: { cookie } }))).json() as { repos: { label: string }[] };
  assert.deepEqual(after.repos.map((item) => item.label), ["acme/other"]);
  assertNoSecret(storedText());
});

test("submodule entries are excluded without a blob read", async () => {
  let reads = 0;
  const walked = await walkSourceTree(indexedSourceTree([{ path: "deps/lib", kind: "submodule" }], async () => { reads += 1; return new Uint8Array(); }), { repo: REPO_URL, commit: "a".repeat(40), capturedAt: CAPTURED });
  assert.equal(reads, 0);
  assert.deepEqual(walked.excluded, [{ path: "deps/lib", reason: "Git submodule; not followed" }]);
});

test("PR/Gate tokens are repository narrowed, exact-capability checked and revoked even for void writes", async () => {
  const prior = process.env.AEGIS_GITHUB_PR_WRITE;
  try {
    delete process.env.AEGIS_GITHUB_PR_WRITE;
    assert.throws(() => withPrInstallation(42, "widget", "pr-open", async () => ({ok:true})), /disabled/);
    assert.equal(calls.tokens.length, 0);
    await withPrInstallation(42, "widget", "gate", async () => undefined);
    assert.deepEqual(calls.tokens[0], {permissions:{metadata:"read",pull_requests:"read",checks:"write"},repositories:["widget"]});
    assert.equal(calls.revokes, 1);
    process.env.AEGIS_GITHUB_PR_WRITE = "true";
    await withPrInstallation(42, "widget", "pr-open", async () => ({ok:true}));
    assert.deepEqual(calls.tokens[1], {permissions:{metadata:"read",contents:"read",pull_requests:"write"},repositories:["widget"]});
    state.tokenPermissions = {metadata:"read",pull_requests:"write",contents:"write"};
    await assert.rejects(withPrInstallation(42,"widget","pr-open",async()=>({ok:true})), /unexpected capability/);
    assert.equal(calls.revokes,3);
    assertNoSecret(storedText());
  } finally { if(prior === undefined) delete process.env.AEGIS_GITHUB_PR_WRITE; else process.env.AEGIS_GITHUB_PR_WRITE=prior; }
});
test("PR snapshots aggregate real Check Runs and exclude only the expected App gate", async () => {
  const sha="d".repeat(40);
  server.use(
    http.get("https://api.github.com/repos/acme/widget/pulls/7",()=>HttpResponse.json({number:7,state:"open",merged:false,head:{sha},base:{sha:"e".repeat(40),repo:{full_name:"acme/widget"}}})),
    http.get("https://api.github.com/repos/acme/widget/commits/:ref/check-runs",()=>HttpResponse.json({total_count:2,check_runs:[{id:1,name:"tests",head_sha:sha,status:"completed",conclusion:"success"},{id:2,name:"aegis/poam-gate",app:{id:12345},head_sha:sha,status:"in_progress",conclusion:null}]})),
  );
  try {
    const snapshot=await readPrSnapshot({installationId:42,owner:"acme",repo:"widget"},7);
    assert.equal(snapshot.headSha,sha);assert.deepEqual(snapshot.ciStatus,{sha,state:"success",checks:1,checkedAt:snapshot.ciStatus.checkedAt});
    assert.deepEqual(calls.tokens[0],{permissions:{metadata:"read",contents:"read",pull_requests:"read",checks:"read"},repositories:["widget"]});
    assert.equal(calls.revokes,1);
    server.use(http.get("https://api.github.com/repos/acme/widget/commits/:ref/check-runs",()=>HttpResponse.json({total_count:2,check_runs:[{id:1,name:"tests",head_sha:sha,status:"completed",conclusion:"success"},{id:3,name:"aegis/poam-gate",app:{id:99999},head_sha:sha,status:"completed",conclusion:"failure"}]})));
    const foreign=await readPrSnapshot({installationId:42,owner:"acme",repo:"widget"},7);
    assert.equal(foreign.ciStatus.state,"failure");assert.equal(foreign.ciStatus.checks,2);
  }finally{server.resetHandlers();}
});


test("a bounded PR snapshot batch uses one credential until every read completes",async()=>{
  const revokes=calls.revokes;
  server.use(
    http.get("https://api.github.com/repos/acme/widget/pulls/:number",async({params})=>{
      if(params.number==="8")await new Promise(resolve=>setTimeout(resolve,20));
      assert.equal(calls.revokes,revokes);
      return HttpResponse.json({number:Number(params.number),state:"open",merged:false,head:{sha:"d".repeat(40)},base:{sha:"e".repeat(40),repo:{full_name:"acme/widget"}}});
    }),
    http.get("https://api.github.com/repos/acme/widget/commits/:ref/check-runs",()=>HttpResponse.json({total_count:0,check_runs:[]})),
  );
  try{
    const snapshots=await readPrSnapshots({installationId:42,owner:"acme",repo:"widget"},[7,8]);
    assert.deepEqual(snapshots.map(p=>p.prNumber),[7,8]);assert.equal(calls.tokens.length,1);assert.equal(calls.revokes,revokes+1);
    assert.ok(snapshots.every(p=>p.ciStatus.state==="pending"));
  }finally{server.resetHandlers();}
});

test("overlapping transient authorities mint independently and cannot revoke each other's credential",async()=>{
  let issued=0;const revoked=new Set<string>();
  server.use(
    http.post("https://api.github.com/app/installations/:id/access_tokens",async({request})=>{
      const body=await request.json() as {permissions:Record<string,string>;repositories:string[]};calls.tokens.push(body);
      const token=TOKEN+"_"+(++issued);await new Promise(resolve=>setTimeout(resolve,20));
      return HttpResponse.json({token,expires_at:"2026-10-25T06:43:00Z",permissions:body.permissions,repository_selection:"selected"});
    }),
    http.delete("https://api.github.com/installation/token",({request})=>{revoked.add(request.headers.get("authorization")??"");calls.revokes++;return new HttpResponse(null,{status:204});}),
    http.get("https://api.github.com/repos/acme/widget/pulls/:number",({request})=>{
      const credential=request.headers.get("authorization")??"";
      if(!credential.includes(TOKEN)||revoked.has(credential))return HttpResponse.json({message:"unavailable"},{status:403});
      return HttpResponse.json({ok:true});
    }),
  );
  try{
    const results=await Promise.allSettled([0,40].map(delay=>withPrInstallation(42,"widget","pr-read",async({octokit})=>{
      await new Promise(resolve=>setTimeout(resolve,delay));
      return (await octokit.request("GET /repos/acme/widget/pulls/{pull_number}",{pull_number:7})).data.ok;
    })));
    assert.equal(calls.tokens.length,2,"Each operation needs an independent provider mint, including overlapping calls.");
    assert.ok(results.every(result=>result.status==="fulfilled"&&result.value===true));
    assert.equal(calls.revokes,2);assert.equal(revoked.size,2);
    assertNoSecret(storedText());
  }finally{server.resetHandlers();}
});

test("failed snapshot batches settle remaining reads before revocation and grant no partial result",async()=>{
  const revokes=calls.revokes;let settled=false;
  server.use(
    http.get("https://api.github.com/repos/acme/widget/pulls/:number",async({params})=>{
      if(params.number==="8")return HttpResponse.json({message:"invalid"},{status:400});
      await new Promise(resolve=>setTimeout(resolve,20));assert.equal(calls.revokes,revokes);settled=true;
      return HttpResponse.json({number:7,state:"open",merged:false,head:{sha:"d".repeat(40)},base:{sha:"e".repeat(40),repo:{full_name:"acme/widget"}}});
    }),
    http.get("https://api.github.com/repos/acme/widget/commits/:ref/check-runs",()=>HttpResponse.json({total_count:0,check_runs:[]})),
  );
  try{
    await assert.rejects(readPrSnapshots({installationId:42,owner:"acme",repo:"widget"},[7,8]),/HTTP 400/);
    assert.equal(settled,true);assert.equal(calls.tokens.length,1);assert.equal(calls.revokes,revokes+1);
  }finally{server.resetHandlers();}
});

});
