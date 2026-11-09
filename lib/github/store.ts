import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { findRepoRoot, dataDir } from "../aegis/paths";
import { sourceCaptureDocument, type SourceCapture, type SourceCaptureDocument } from "../collector/source-tree";
import { blobGetText, blobPutText, persistenceMode } from "../durable";
import { storageKey } from "../storage-key";
import { GithubRejected } from "./config";
import type { ConnectedRepo } from "./client";

export type InstallationRecord = {
  installationId: number;
  accountLogin: string;
  accountType: "Organization" | "User";
  repos: ConnectedRepo[];
  connectedAt: string;
  updatedAt: string;
  suspended: boolean;
};

export type CaptureIndex = {
  id: string;
  repo: string;
  commit: string;
  capturedAt: string;
  installationId: number;
};

type OwnerFile = { version: 1; installations: InstallationRecord[]; captures: CaptureIndex[] };
type InstallationFile = { version: 1; ownerHash: string | null; installation: InstallationRecord };

const CAPTURE_LIMIT = 40;

export function ownerHash(owner: string): string {
  return createHash("sha256").update(`github-owner\0${owner}`).digest("hex");
}

function ownerKey(hash: string): string {
  return storageKey(["github", "owners", `${hash}.json`]);
}
function installationKey(id: number): string {
  return storageKey(["github", "installations", `${id}.json`]);
}
function captureKey(id: string): string {
  return storageKey(["github", "captures", `${id}.json`]);
}

function localFile(key: string, root: string): string {
  return path.join(dataDir(root), key);
}

async function readText(key: string, root: string): Promise<string | null> {
  if (persistenceMode() === "blob") return blobGetText(key);
  try {
    return readFileSync(localFile(key, root), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("GitHub connection record could not be read.");
  }
}

async function writeText(key: string, value: string, root: string): Promise<void> {
  if (persistenceMode() === "blob") {
    await blobPutText(key, value, true);
    return;
  }
  const file = localFile(key, root);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, value, { mode: 0o600 });
}

function emptyOwner(): OwnerFile {
  return { version: 1, installations: [], captures: [] };
}

function isRepo(value: unknown): value is ConnectedRepo {
  const repo = value as ConnectedRepo;
  return !!repo && typeof repo.owner === "string" && typeof repo.name === "string" && typeof repo.private === "boolean";
}

function isInstallation(value: unknown): value is InstallationRecord {
  const record = value as InstallationRecord;
  return !!record && Number.isSafeInteger(record.installationId) && record.installationId > 0
    && typeof record.accountLogin === "string" && (record.accountType === "Organization" || record.accountType === "User")
    && Array.isArray(record.repos) && record.repos.every(isRepo) && typeof record.connectedAt === "string"
    && typeof record.updatedAt === "string" && typeof record.suspended === "boolean";
}

async function readOwnerFile(hash: string, root: string): Promise<OwnerFile> {
  const raw = await readText(ownerKey(hash), root);
  if (!raw) return emptyOwner();
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error("GitHub connection record could not be read."); }
  const file = parsed as OwnerFile;
  if (!file || file.version !== 1 || !Array.isArray(file.installations) || !Array.isArray(file.captures)) {
    throw new Error("GitHub connection record could not be read.");
  }
  if (!file.installations.every(isInstallation)) throw new Error("GitHub connection record could not be read.");
  return { version: 1, installations: file.installations, captures: file.captures.filter(isCapture) };
}

function isCapture(value: unknown): value is CaptureIndex {
  const capture = value as CaptureIndex;
  return !!capture && /^[a-f0-9]{64}$/.test(capture.id) && typeof capture.repo === "string" && /^[a-f0-9]{40}$/.test(capture.commit)
    && typeof capture.capturedAt === "string" && Number.isSafeInteger(capture.installationId);
}

async function readInstallationFile(id: number, root: string): Promise<InstallationFile | null> {
  const raw = await readText(installationKey(id), root);
  if (!raw) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error("GitHub connection record could not be read."); }
  const file = parsed as InstallationFile;
  if (!file || file.version !== 1 || (file.ownerHash !== null && !/^[a-f0-9]{64}$/.test(file.ownerHash)) || !isInstallation(file.installation)) {
    throw new Error("GitHub connection record could not be read.");
  }
  return file;
}

export async function installationsFor(owner: string, root = findRepoRoot()): Promise<InstallationRecord[]> {
  const file = await readOwnerFile(ownerHash(owner), root);
  return file.installations;
}

export async function connectedRepos(owner: string, root = findRepoRoot()): Promise<{ installation: InstallationRecord; repo: ConnectedRepo }[]> {
  const rows = [];
  for (const installation of await installationsFor(owner, root)) {
    for (const repo of installation.repos) rows.push({ installation, repo });
  }
  return rows.sort((a, b) => `${a.repo.owner}/${a.repo.name}`.localeCompare(`${b.repo.owner}/${b.repo.name}`));
}

export async function findConnectedRepo(owner: string, repoOwner: string, name: string, root = findRepoRoot()): Promise<{ installation: InstallationRecord; repo: ConnectedRepo } | null> {
  const match = (await connectedRepos(owner, root)).filter((row) => row.repo.owner.toLowerCase() === repoOwner.toLowerCase() && row.repo.name.toLowerCase() === name.toLowerCase() && !row.installation.suspended);
  return match.sort((a, b) => b.installation.updatedAt.localeCompare(a.installation.updatedAt))[0] ?? null;
}

/**
 * Bind an installation to an owner. A different owner cannot take it over.
 * Passing owner null records an unclaimed webhook until the setup callback claims it.
 */
export async function saveInstallation(owner: string | null, installation: InstallationRecord, root = findRepoRoot()): Promise<void> {
  const current = await readInstallationFile(installation.installationId, root);
  const nextHash = owner ? ownerHash(owner) : current?.ownerHash ?? null;
  if (current?.ownerHash && nextHash && current.ownerHash !== nextHash) throw new GithubRejected("That GitHub installation is already connected to another session.", 409);
  if (owner && current?.ownerHash && current.ownerHash !== ownerHash(owner)) throw new GithubRejected("That GitHub installation is already connected to another session.", 409);
  const file: InstallationFile = { version: 1, ownerHash: owner ? ownerHash(owner) : current?.ownerHash ?? null, installation };
  await writeText(installationKey(installation.installationId), JSON.stringify(file), root);
  if (current?.ownerHash && current.ownerHash !== file.ownerHash) await detach(current.ownerHash, installation.installationId, root);
  if (file.ownerHash) await attach(file.ownerHash, installation, root);
}

async function attach(hash: string, installation: InstallationRecord, root: string): Promise<void> {
  const file = await readOwnerFile(hash, root);
  const installations = file.installations.filter((item) => item.installationId !== installation.installationId);
  installations.push(installation);
  await writeText(ownerKey(hash), JSON.stringify({ ...file, installations }), root);
}

async function detach(hash: string, installationId: number, root: string): Promise<void> {
  const file = await readOwnerFile(hash, root);
  await writeText(ownerKey(hash), JSON.stringify({ ...file, installations: file.installations.filter((item) => item.installationId !== installationId) }), root);
}

export async function updateInstallation(installationId: number, update: (current: InstallationRecord | null) => InstallationRecord | null, root = findRepoRoot()): Promise<void> {
  const current = await readInstallationFile(installationId, root);
  const next = update(current?.installation ?? null);
  if (!next) {
    if (!current) return;
    await writeText(installationKey(installationId), JSON.stringify({ version: 1, ownerHash: null, installation: { ...current.installation, repos: [], suspended: true } }), root);
    if (current.ownerHash) await detach(current.ownerHash, installationId, root);
    return;
  }
  const owner = current?.ownerHash ?? null;
  const file: InstallationFile = { version: 1, ownerHash: owner, installation: next };
  await writeText(installationKey(installationId), JSON.stringify(file), root);
  if (owner) await attach(owner, next, root);
}

export async function saveCapture(owner: string, capture: SourceCapture, installationId: number, root = findRepoRoot()): Promise<string> {
  const id = randomBytes(32).toString("hex");
  const document = sourceCaptureDocument([capture]);
  await writeText(captureKey(id), JSON.stringify(document), root);
  const hash = ownerHash(owner);
  const file = await readOwnerFile(hash, root);
  const captures = [...file.captures, { id, repo: capture.source.repo, commit: capture.source.commit, capturedAt: capture.source.capturedAt, installationId }];
  await writeText(ownerKey(hash), JSON.stringify({ ...file, captures: captures.slice(-CAPTURE_LIMIT) }), root);
  return id;
}

export async function readCapture(owner: string, id: string, root = findRepoRoot()): Promise<SourceCaptureDocument | null> {
  if (!/^[a-f0-9]{64}$/.test(id)) return null;
  const file = await readOwnerFile(ownerHash(owner), root);
  if (!file.captures.some((capture) => capture.id === id)) return null;
  const raw = await readText(captureKey(id), root);
  if (!raw) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error("GitHub capture could not be read."); }
  const document = parsed as SourceCaptureDocument & Record<string, unknown>;
  if (!document || document.schema !== "aegis.source-capture.v1" || !Array.isArray(document.captures)) throw new Error("GitHub capture could not be read.");
  return { schema: "aegis.source-capture.v1", captures: document.captures };
}

type NonceFile = { version: 1; owner: string; exp: number; used: boolean };

function nonceKey(nonce: string): string {
  return storageKey(["github", "states", `${createHash("sha256").update(nonce).digest("hex")}.json`]);
}

export async function rememberInstallNonce(nonce: string, owner: string, exp: number, root = findRepoRoot()): Promise<void> {
  const file: NonceFile = { version: 1, owner, exp, used: false };
  await writeText(nonceKey(nonce), JSON.stringify(file), root);
}

/** Single-use. Returns the owner bound to the nonce, then marks it used. */
export async function consumeInstallNonce(nonce: string, now = Date.now(), root = findRepoRoot()): Promise<string | null> {
  const key = nonceKey(nonce);
  const raw = await readText(key, root);
  if (!raw) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; }
  const file = parsed as NonceFile;
  if (!file || file.version !== 1 || file.used || typeof file.owner !== "string" || typeof file.exp !== "number" || file.exp < now) return null;
  await writeText(key, JSON.stringify({ ...file, used: true }), root);
  return file.owner;
}

/** A server-side connection binding may use an installation only while its repository remains connected. */
export async function activeInstallationRepo(installationId: number, owner: string, repo: string) {
  const file = await readInstallationFile(installationId, findRepoRoot());
  return !!file?.ownerHash && !file.installation.suspended && file.installation.repos.some(r => r.owner.toLowerCase() === owner.toLowerCase() && r.name.toLowerCase() === repo.toLowerCase());
}
