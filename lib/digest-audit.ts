import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { FileComparison } from "./digest-model";
import { sha256Bytes } from "./aegis/hash";
import { dataDir, findRepoRoot } from "./aegis/paths";
import { AegisError } from "./aegis/errors";
import { blobGetText, blobPutText, listBlobPathnames, persistenceMode, PREVIEW_STORE_REFUSED, storageUnconfigured } from "./durable";
import { getStorage } from "./storage";
import { storageKey } from "./storage-key";

export const DIGEST_KIND = ["evidence", "export"] as const;
export type DigestKind = (typeof DIGEST_KIND)[number];

/** Fields a refused read returns. `id` is set when the audit row was recorded. */
export type DigestRefusalDetails = {
  objectName: string;
  objectKey: string;
  recordedDigest: string;
  recomputedDigest: string;
  kind: DigestKind;
  refusedAt: string;
  id?: string;
};

/** Append only audit row. Same fields as the refusal, with a required id. */
export type DigestAuditEntry = {
  id: string;
  objectKey: string;
  objectName: string;
  recordedDigest: string;
  recomputedDigest: string;
  kind: DigestKind;
  refusedAt: string;
};

export type DigestRefusalGroup = {
  objectKey: string;
  objectName: string;
  kind: DigestKind;
  recordedDigest: string;
  recomputedDigest: string;
  truncated: boolean;
  entries: DigestAuditEntry[];
};

export type StoredDigestCheck = {
  files?: FileComparison[];
  matched: number;
  mismatched: number;
  skipped: number;
  checkedAt: string;
};

export const DIGEST_CHECK_NOTE =
  "A matching digest means the stored bytes equal the recorded digest. It is not approval. Objects without a recorded digest or a stored file are skipped.";

const ENTRY_CAP = 500;
const STORE_UNAVAILABLE_MESSAGE =
  "Evidence and exports need durable storage on Vercel. Set BLOB_READ_WRITE_TOKEN or AEGIS_DATA_DIR. The instance directory is not used.";

export function digestMismatchMessage(kind: DigestKind): string {
  const label = kind === "evidence" ? "Evidence file" : "Export";
  return `${label} SHA 256 does not match the digest recorded when it was stored.`;
}

export function storedObjectName(location: string): string {
  const base = path.basename(location).replace(/[\u0000-\u001f]/g, "");
  return (base || "object").slice(0, 240);
}

/** Stable id for one stored object. Blob keys and directory paths stay distinct. */
export function digestObjectKey(location: string): string {
  if (location.startsWith("aegis/")) return sha256Bytes(`blob:${location}`);
  const mode = durableMode();
  if (mode === "directory") {
    const base = dataDir(findRepoRoot());
    const resolved = path.resolve(location);
    const relative = path.relative(base, resolved);
    if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
      return sha256Bytes(`dir:${relative.split(path.sep).join("/")}`);
    }
  }
  return sha256Bytes(`file:${path.resolve(location)}`);
}

export function ownerForStoredObject(location: string): string {
  const blob = /^aegis\/sessions\/([a-f0-9]{32})\//.exec(location);
  if (blob?.[1]) return blob[1];
  const directory = /[/\\]sessions[/\\]([a-f0-9]{32})[/\\]/.exec(location);
  if (directory?.[1]) return directory[1];
  return "unscoped";
}

type DurableMode = "blob" | "directory" | "unconfigured" | "preview-refused";

function durableMode(): DurableMode {
  try {
    return persistenceMode();
  } catch (error) {
    if (storageUnconfigured(error)) return "unconfigured";
    if (error instanceof Error && error.message === PREVIEW_STORE_REFUSED) return "preview-refused";
    throw error;
  }
}

function storeUnavailable(mode: DurableMode): AegisError {
  const message = mode === "preview-refused" ? PREVIEW_STORE_REFUSED : STORE_UNAVAILABLE_MESSAGE;
  return new AegisError("STORE_UNAVAILABLE", message, 503);
}

function requireMode(): "blob" | "directory" {
  const mode = durableMode();
  if (mode === "blob" || mode === "directory") return mode;
  throw storeUnavailable(mode);
}

function assertOwner(owner: string): string {
  if (!/^[a-z0-9]{1,64}$/.test(owner)) throw new Error("Refusing a malformed ownership key.");
  return owner;
}

function assertObjectKey(objectKey: string): string {
  if (!/^[a-f0-9]{64}$/.test(objectKey)) {
    throw new AegisError("BAD_REQUEST", "Object key must be 64 hex characters.", 400);
  }
  return objectKey;
}

function auditFile(owner: string, objectKey: string, id: string): string {
  return path.join(dataDir(findRepoRoot()), "digest-refusals", owner, objectKey, `${id}.json`);
}

function auditBlobName(owner: string, objectKey: string, id: string): string {
  return storageKey(["sessions", owner, "digest-refusals", objectKey, `${id}.json`]);
}

function checkFile(owner: string): string {
  return path.join(dataDir(findRepoRoot()), "digest-checks", `${owner}.json`);
}

function checkBlobName(owner: string): string {
  return storageKey(["sessions", owner, "digest-checks", "latest.json"]);
}

/**
 * Append one refusal. Directory writes are exclusive. Blob writes do not overwrite.
 * Returns a promise for Blob and undefined when the directory write already finished.
 * Returns undefined without writing when durable storage is not configured.
 */
export function writeDigestAudit(owner: string, entry: DigestAuditEntry): Promise<void> | undefined {
  const mode = durableMode();
  if (mode === "unconfigured") return undefined;
  if (mode === "preview-refused") throw new Error(PREVIEW_STORE_REFUSED);
  const safeOwner = assertOwner(owner);
  const body = JSON.stringify(entry);
  if (mode === "directory") {
    const file = auditFile(safeOwner, entry.objectKey, entry.id);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, body, { flag: "wx" });
    return undefined;
  }
  return blobPutText(auditBlobName(safeOwner, entry.objectKey, entry.id), body, false);
}

function parseEntry(value: unknown, objectKey: string): DigestAuditEntry | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || !/^[a-f0-9]{32}$/.test(record.id)) return null;
  if (record.objectKey !== objectKey) return null;
  if (typeof record.objectName !== "string" || record.objectName.length === 0 || record.objectName.length > 240) return null;
  if (typeof record.recordedDigest !== "string" || !/^[a-f0-9]{64}$/.test(record.recordedDigest)) return null;
  if (typeof record.recomputedDigest !== "string" || !/^[a-f0-9]{64}$/.test(record.recomputedDigest)) return null;
  if (record.kind !== "evidence" && record.kind !== "export") return null;
  if (typeof record.refusedAt !== "string" || !Number.isFinite(Date.parse(record.refusedAt))) return null;
  return {
    id: record.id,
    objectKey,
    objectName: record.objectName,
    recordedDigest: record.recordedDigest,
    recomputedDigest: record.recomputedDigest,
    kind: record.kind,
    refusedAt: record.refusedAt,
  };
}

function sortEntries(entries: DigestAuditEntry[]): DigestAuditEntry[] {
  return [...entries].sort((a, b) => a.refusedAt.localeCompare(b.refusedAt) || a.id.localeCompare(b.id));
}

async function readEntryText(location: string, mode: "blob" | "directory"): Promise<string | null> {
  if (mode === "blob") return blobGetText(location);
  if (!getStorage().exists(location)) return null;
  return getStorage().read(location).toString("utf8");
}

export async function listDigestAuditPaths(owner: string, objectKey: string): Promise<string[]> {
  const mode = requireMode();
  const safeOwner = assertOwner(owner);
  const safeKey = assertObjectKey(objectKey);
  if (mode === "directory") {
    const dir = path.join(dataDir(findRepoRoot()), "digest-refusals", safeOwner, safeKey);
    if (!getStorage().exists(dir)) return [];
    return readdirSync(dir)
      .filter((name) => /^[a-f0-9]{32}\.json$/.test(name))
      .map((name) => path.join(dir, name));
  }
  const prefix = `${storageKey(["sessions", safeOwner, "digest-refusals", safeKey])}/`;
  const blobs = await listBlobPathnames(prefix);
  return blobs.map((blob) => blob.pathname);
}

export async function listDigestAuditsForObject(owner: string, objectKey: string): Promise<{ truncated: boolean; entries: DigestAuditEntry[] }> {
  const mode = requireMode();
  const safeKey = assertObjectKey(objectKey);
  const paths = await listDigestAuditPaths(owner, safeKey);
  const truncated = paths.length > ENTRY_CAP;
  const selected = truncated ? paths.slice(0, ENTRY_CAP) : paths;
  const entries: DigestAuditEntry[] = [];
  for (const location of selected) {
    try {
      const text = await readEntryText(location, mode);
      if (!text) continue;
      const parsed = parseEntry(JSON.parse(text) as unknown, safeKey);
      if (parsed) entries.push(parsed);
    } catch {
      // A damaged row stays on disk and stays out of the trail.
    }
  }
  const sorted = sortEntries(entries);
  return { truncated, entries: truncated ? sorted.slice(-ENTRY_CAP) : sorted };
}

export async function listDigestAudits(owner: string): Promise<{ truncated: boolean; entries: DigestAuditEntry[] }> {
  const mode = requireMode();
  const safeOwner = assertOwner(owner);
  if (mode === "directory") {
    const root = path.join(dataDir(findRepoRoot()), "digest-refusals", safeOwner);
    if (!getStorage().exists(root)) return { truncated: false, entries: [] };
    const objectKeys = readdirSync(root).filter((name) => /^[a-f0-9]{64}$/.test(name));
    const groups = await Promise.all(objectKeys.map((objectKey) => listDigestAuditsForObject(safeOwner, objectKey)));
    return {
      truncated: groups.some((group) => group.truncated),
      entries: groups.flatMap((group) => group.entries),
    };
  }
  const prefix = `${storageKey(["sessions", safeOwner, "digest-refusals"])}/`;
  const blobs = await listBlobPathnames(prefix);
  const entries: DigestAuditEntry[] = [];
  let truncated = blobs.length > ENTRY_CAP * 4;
  for (const blob of blobs.slice(0, ENTRY_CAP * 4)) {
    const match = /^aegis\/sessions\/[a-z0-9]+\/digest-refusals\/([a-f0-9]{64})\/[a-f0-9]{32}\.json$/.exec(blob.pathname);
    if (!match?.[1]) continue;
    try {
      const text = await blobGetText(blob.pathname);
      if (!text) continue;
      const parsed = parseEntry(JSON.parse(text) as unknown, match[1]);
      if (parsed) entries.push(parsed);
    } catch {
      // A damaged row stays on disk and stays out of the trail.
    }
  }
  const sorted = sortEntries(entries);
  if (sorted.length > ENTRY_CAP * 4) truncated = true;
  return { truncated, entries: truncated ? sorted.slice(-(ENTRY_CAP * 4)) : sorted };
}

export function groupDigestRefusals(entries: DigestAuditEntry[], truncated = false): DigestRefusalGroup[] {
  const groups = new Map<string, DigestAuditEntry[]>();
  for (const entry of entries) {
    const list = groups.get(entry.objectKey) ?? [];
    list.push(entry);
    groups.set(entry.objectKey, list);
  }
  const result: DigestRefusalGroup[] = [];
  for (const [objectKey, list] of groups) {
    const ordered = sortEntries(list);
    const latest = ordered[ordered.length - 1];
    if (!latest) continue;
    result.push({
      objectKey,
      objectName: latest.objectName,
      kind: latest.kind,
      recordedDigest: latest.recordedDigest,
      recomputedDigest: latest.recomputedDigest,
      truncated,
      entries: ordered,
    });
  }
  result.sort((a, b) => {
    const aAt = a.entries[a.entries.length - 1]?.refusedAt ?? "";
    const bAt = b.entries[b.entries.length - 1]?.refusedAt ?? "";
    return bAt.localeCompare(aAt) || a.objectKey.localeCompare(b.objectKey);
  });
  return result;
}

function parseCheck(value: unknown): StoredDigestCheck | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  for (const key of ["matched", "mismatched", "skipped"] as const) {
    const count = record[key];
    if (typeof count !== "number" || !Number.isInteger(count) || count < 0) return null;
  }
  if (typeof record.checkedAt !== "string" || !Number.isFinite(Date.parse(record.checkedAt))) return null;
  return {
    files: Array.isArray(record.files) ? record.files.filter((file): file is FileComparison => !!file && typeof file === "object" && /^[a-f0-9]{64}$/.test(file.objectKey) && typeof file.objectName === "string" && ["evidence", "export"].includes(file.kind) && ["match", "mismatch", "unreadable", "unverified"].includes(file.result)) : undefined,
    matched: record.matched as number,
    mismatched: record.mismatched as number,
    skipped: record.skipped as number,
    checkedAt: record.checkedAt,
  };
}

export async function writeDigestCheck(owner: string, check: StoredDigestCheck): Promise<void> {
  const mode = requireMode();
  const safeOwner = assertOwner(owner);
  const body = JSON.stringify(check);
  if (mode === "directory") {
    getStorage().write(checkFile(safeOwner), body);
    return;
  }
  await blobPutText(checkBlobName(safeOwner), body, true);
}

export async function readDigestCheck(owner: string): Promise<StoredDigestCheck | null> {
  const mode = requireMode();
  const safeOwner = assertOwner(owner);
  try {
    const text = mode === "directory"
      ? (getStorage().exists(checkFile(safeOwner)) ? getStorage().read(checkFile(safeOwner)).toString("utf8") : null)
      : await blobGetText(checkBlobName(safeOwner));
    if (!text) return null;
    return parseCheck(JSON.parse(text) as unknown);
  } catch (error) {
    if (error instanceof AegisError) throw error;
    return null;
  }
}
