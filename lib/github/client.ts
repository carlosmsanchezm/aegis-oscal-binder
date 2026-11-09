import { App } from "@octokit/app";
import { Octokit } from "@octokit/rest";
import { indexedSourceTree, isSkippedDirectory, sourceCapture, walkSourceTree, type IndexedEntry, type SourceCapture, type SourceEntryKind } from "../collector/source-tree";
import { withListInstallation, withScanInstallation } from "./auth";
import { GithubRejected, GithubRequestError, githubAppConfig, silentLog } from "./config";
import { assertAppPermissions } from "./permissions";

const NAME = /^[A-Za-z0-9_.-]{1,100}$/;

export type ConnectedRepo = { owner: string; name: string; private: boolean };

export function assertRepoName(value: string): string {
  if (!NAME.test(value) || value === "." || value === "..") throw new GithubRejected("Use a GitHub owner and repository name.", 400);
  return value;
}

export function assertRef(value: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 255) throw new GithubRejected("Pin a branch, tag, or commit.", 400);
  if (value.startsWith("/") || value.endsWith("/") || value.includes("..") || value.includes("//")) throw new GithubRejected("Pin a branch, tag, or commit.", 400);
  if (!/^[A-Za-z0-9._/-]+$/.test(value)) throw new GithubRejected("Pin a branch, tag, or commit.", 400);
  return value;
}

export function repoUrl(owner: string, name: string): string {
  return `https://github.com/${assertRepoName(owner)}/${assertRepoName(name)}`;
}

export function installUrl(state?: string): string {
  const url = new URL(`https://github.com/apps/${githubAppConfig().slug}/installations/new`);
  if (state) url.searchParams.set("state", state);
  return url.toString();
}

function app(): App<{ Octokit: typeof Octokit }> {
  const config = githubAppConfig();
  return new App({
    appId: config.appId,
    privateKey: config.privateKey,
    webhooks: { secret: config.webhookSecret },
    Octokit,
    log: silentLog,
  });
}

export async function verifyWebhook(payload: string, signature: string): Promise<boolean> {
  return app().webhooks.verify(payload, signature);
}

type InstallationAccount = {
  installationId: number;
  accountLogin: string;
  accountType: "Organization" | "User";
  suspended: boolean;
  permissions: Record<string, string>;
};

export async function readInstallation(installationId: number): Promise<InstallationAccount> {
  if (!Number.isSafeInteger(installationId) || installationId <= 0) throw new GithubRejected("GitHub installation id is required.", 400);
  let account: { login?: string; type?: string } | null = null;
  let permissions: Record<string, string> = {};
  let suspended = false;
  try {
    const response = await app().octokit.rest.apps.getInstallation({ installation_id: installationId });
    const body = response.data;
    if (body.account && "login" in body.account) account = { login: body.account.login, type: body.account.type };
    permissions = body.permissions ?? {};
    suspended = Boolean(body.suspended_at);
  } catch (error) {
    const status = statusOf(error);
    if (status === 404) throw new GithubRejected("That GitHub installation is not available to this app.", 404);
    throw new GithubRequestError(status);
  }
  const login = account?.login ?? "";
  const type = account?.type === "Organization" ? "Organization" : account?.type === "User" ? "User" : null;
  if (!type || !NAME.test(login)) throw new GithubRejected("GitHub installation account was not readable.", 502);
  assertAppPermissions(permissions);
  return { installationId, accountLogin: login, accountType: type, suspended, permissions };
}

export async function listInstallationRepos(installationId: number): Promise<ConnectedRepo[]> {
  return withListInstallation(installationId, async ({ octokit }) => {
    const repos: ConnectedRepo[] = [];
    for (let page = 1; page <= 20; page += 1) {
      let data: { repositories: { name?: string; full_name?: string; private?: boolean; owner?: { login?: string } }[] };
      try {
        const response = await octokit.rest.apps.listReposAccessibleToInstallation({ per_page: 100, page });
        data = response.data;
      } catch (error) {
        throw new GithubRequestError(statusOf(error));
      }
      for (const repo of data.repositories) repos.push(...readRepo(repo));
      if (data.repositories.length < 100) return repos;
    }
    throw new GithubRejected("That installation exposes more repositories than this connection lists.", 409);
  });
}

export function readRepo(value: { name?: string; full_name?: string; private?: boolean; owner?: { login?: string } }): ConnectedRepo[] {
  const name = value.name ?? "";
  const owner = value.owner?.login || value.full_name?.split("/")[0] || "";
  if (!NAME.test(owner) || !NAME.test(name) || owner === "." || name === "." || owner === ".." || name === "..") return [];
  return [{ owner, name, private: value.private === true }];
}

function isSafePath(file: string): boolean {
  if (!file || file.length > 500 || file.startsWith("/") || file.includes("\\") || /[\u0000-\u001f]/.test(file)) return false;
  return file.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}

function entryKind(mode: string, type: string): SourceEntryKind {
  if (mode === "120000") return "symlink";
  if (mode === "160000" || type === "commit") return "submodule";
  if (type === "tree" || mode === "040000") return "directory";
  return "file";
}

type TreeItem = { path?: string; mode?: string; type?: string; sha?: string; size?: number };

/** Recursive tree when GitHub returns it whole; otherwise one request per directory, skipping dependency trees. */
export async function loadGithubEntries(octokit: Octokit, owner: string, repo: string, commit: string): Promise<{ entries: IndexedEntry[]; blobs: Map<string, string>; unsafe: number }> {
  const first = await getTree(octokit, owner, repo, commit, true);
  const items = first.truncated ? await loadUntruncated(octokit, owner, repo, commit) : first.tree;
  const entries: IndexedEntry[] = [];
  const blobs = new Map<string, string>();
  let unsafe = 0;
  for (const item of items) {
    const file = item.path ?? "";
    if (!isSafePath(file)) {
      unsafe += 1;
      continue;
    }
    const kind = entryKind(String(item.mode ?? ""), String(item.type ?? ""));
    const size = typeof item.size === "number" ? item.size : null;
    entries.push({ path: file, kind, size: kind === "file" ? size : null });
    if (kind === "file" && item.sha) blobs.set(file, item.sha);
  }
  return { entries, blobs, unsafe };
}

async function loadUntruncated(octokit: Octokit, owner: string, repo: string, treeSha: string): Promise<TreeItem[]> {
  const items: TreeItem[] = [];
  async function walk(sha: string, prefix: string): Promise<void> {
    const page = await getTree(octokit, owner, repo, sha, false);
    if (page.truncated) throw new GithubRejected("GitHub truncated a single directory tree.", 502);
    for (const item of page.tree) {
      const name = item.path ?? "";
      if (!name || name.includes("/")) continue;
      const file = prefix ? `${prefix}/${name}` : name;
      const kind = entryKind(String(item.mode ?? ""), String(item.type ?? ""));
      items.push({ ...item, path: file });
      if (kind === "directory" && item.sha && !isSkippedDirectory(name)) {
        await walk(item.sha, file);
      }
    }
  }
  await walk(treeSha, "");
  return items;
}

async function getTree(octokit: Octokit, owner: string, repo: string, treeSha: string, recursive: boolean): Promise<{ truncated: boolean; tree: TreeItem[] }> {
  try {
    const response = await octokit.rest.git.getTree({
      owner,
      repo,
      tree_sha: treeSha,
      ...(recursive ? { recursive: "1" } : {}),
    });
    return { truncated: response.data.truncated === true, tree: response.data.tree };
  } catch (error) {
    throw new GithubRequestError(statusOf(error));
  }
}

async function readBlob(octokit: Octokit, owner: string, repo: string, sha: string): Promise<Uint8Array> {
  try {
    const response = await octokit.request("GET /repos/{owner}/{repo}/git/blobs/{file_sha}", {
      owner,
      repo,
      file_sha: sha,
      headers: { accept: "application/vnd.github.raw" },
    });
    const data: unknown = response.data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    if (typeof data === "string") return new TextEncoder().encode(data);
    throw new GithubRequestError(0);
  } catch (error) {
    if (error instanceof GithubRequestError) throw error;
    throw new GithubRequestError(statusOf(error));
  }
}

export async function scanPinnedRepository(input: {
  installationId: number;
  owner: string;
  repo: string;
  ref: string;
  capturedAt: string;
}): Promise<SourceCapture> {
  const owner = assertRepoName(input.owner);
  const repo = assertRepoName(input.repo);
  const ref = assertRef(input.ref);
  const capturedAt = input.capturedAt;
  if (!Number.isFinite(Date.parse(capturedAt))) throw new GithubRejected("Capture time is required.", 400);
  return withScanInstallation(input.installationId, repo, async ({ octokit }) => {
    let commit = "";
    try {
      const response = await octokit.rest.repos.getCommit({ owner, repo, ref });
      commit = response.data.sha;
    } catch (error) {
      const status = statusOf(error);
      if (status === 404) throw new GithubRejected("That ref was not found on the repository.", 404);
      throw new GithubRequestError(status);
    }
    if (!/^[a-f0-9]{40}$/.test(commit)) throw new GithubRequestError(0);
    const loaded = await loadGithubEntries(octokit, owner, repo, commit);
    const tree = indexedSourceTree(loaded.entries, (file) => {
      const sha = loaded.blobs.get(file);
      if (!sha) return Promise.reject(new GithubRequestError(0));
      return readBlob(octokit, owner, repo, sha);
    });
    const walked = await walkSourceTree(tree, { repo: repoUrl(owner, repo), commit, capturedAt });
    const excluded = loaded.unsafe ? [...walked.excluded, { path: "(omitted)", reason: "Unsupported path" }] : walked.excluded;
    return sourceCapture(walked.files, excluded, { repo: repoUrl(owner, repo), commit, capturedAt });
  });
}

function statusOf(error: unknown): number {
  return typeof error === "object" && error && "status" in error && typeof (error as { status: unknown }).status === "number"
    ? (error as { status: number }).status
    : 0;
}
