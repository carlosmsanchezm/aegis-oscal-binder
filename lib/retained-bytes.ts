import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { AegisError } from "./aegis/errors";
import { sha256Bytes } from "./aegis/hash";
import { resolveEvidenceHref } from "./aegis/paths";
import type { PersistedState } from "./aegis/types";
import {
  digestMismatchMessage,
  digestObjectKey,
  ownerForStoredObject,
  storedObjectName,
  writeDigestAudit,
  type DigestAuditEntry,
  type DigestKind,
  type DigestRefusalDetails,
} from "./digest-audit";
import { blobGetBytes, blobPutBytes, persistenceMode, PREVIEW_STORE_REFUSED, storageUnconfigured } from "./durable";
import { getStorage } from "./storage";
import { evidenceBlobKey } from "./storage-key";

export const DIGEST_MISMATCH_CODE = "DIGEST_MISMATCH";
export const DIGEST_UNVERIFIED_CODE = "DIGEST_UNVERIFIED";
export const DIGEST_UNVERIFIED_MESSAGE = "Stored bytes were returned without a recorded SHA 256 digest.";

export type RetainedReadOptions = {
  /** When false, a mismatch is still refused and is not appended to the audit trail. */
  recordAudit?: boolean;
  ownerKey?: string;
  /** Recompute from the stored bytes instead of a previous mismatch remembered in this process. */
  bypassCache?: boolean;
};

type MismatchFact = {
  objectKey: string;
  objectName: string;
  recordedDigest: string;
  recomputedDigest: string;
  kind: DigestKind;
};

const stage = new Map<string, Buffer>();
const failures = new Map<string, MismatchFact>();
const unverified = new Map<string, string>();
type PendingWrite = Promise<Error | undefined>;
const processPending: PendingWrite[] = [];
const retainedRequests = new AsyncLocalStorage<{ pending: PendingWrite[]; ownerKey?: string }>();

/** One write list per request so a failed write cannot reject another request. */
export function runRetainedRequest<T>(fn: () => T, ownerKey?: string): T {
  return retainedRequests.run({ pending: [], ownerKey }, fn);
}

function pendingList(): PendingWrite[] {
  return retainedRequests.getStore()?.pending ?? processPending;
}

function resolveOwner(location: string, explicit?: string): string {
  if (explicit && /^[a-z0-9]{1,64}$/.test(explicit)) return explicit;
  const scoped = retainedRequests.getStore()?.ownerKey;
  if (scoped && /^[a-z0-9]{1,64}$/.test(scoped)) return scoped;
  return ownerForStoredObject(location);
}

function kindFromLabel(label: string): DigestKind {
  if (label === "Evidence file") return "evidence";
  if (label === "Export") return "export";
  throw new Error("Unknown retained object kind.");
}

function trackAudit(owner: string, entry: DigestAuditEntry): void {
  let pending: Promise<void> | undefined;
  try {
    pending = writeDigestAudit(owner, entry);
  } catch (error) {
    if (error instanceof Error && error.message === PREVIEW_STORE_REFUSED) throw error;
    throw error;
  }
  if (!pending) return;
  const recorded = pending.then(
    () => undefined,
    (error: unknown) => (error instanceof Error ? error : new Error("Durable write failed.")),
  );
  pendingList().push(recorded);
}

function refuse(location: string, fact: MismatchFact, options: RetainedReadOptions | undefined): never {
  failures.set(location, fact);
  const refusedAt = new Date().toISOString();
  const details: DigestRefusalDetails = { ...fact, refusedAt };
  if (options?.recordAudit !== false) {
    const id = randomBytes(16).toString("hex");
    details.id = id;
    trackAudit(resolveOwner(location, options?.ownerKey), { id, ...fact, refusedAt });
  }
  throw new AegisError(DIGEST_MISMATCH_CODE, digestMismatchMessage(fact.kind), 409, details);
}

export function isBlobLocation(location: string): boolean {
  return location.startsWith("aegis/");
}

export function retainedFailure(location: string): string | null {
  const fact = failures.get(location);
  return fact ? digestMismatchMessage(fact.kind) : null;
}

function blobEnabled(ownerKey?: string): boolean {
  if (!ownerKey || !/^[a-f0-9]{32}$/.test(ownerKey)) return false;
  try {
    return persistenceMode() === "blob";
  } catch (error) {
    if (error instanceof Error && error.message === PREVIEW_STORE_REFUSED) throw error;
    if (storageUnconfigured(error)) return false;
    throw error;
  }
}

export function retainedUnverified(location: string): string | null {
  return unverified.get(location) ?? null;
}

export function assertStoredDigest(
  location: string,
  bytes: Buffer,
  expected: string | undefined,
  label: string,
  options?: RetainedReadOptions,
): void {
  if (!expected) {
    unverified.set(location, DIGEST_UNVERIFIED_MESSAGE);
    return;
  }
  unverified.delete(location);
  const recordedDigest = expected.toLowerCase();
  const recomputedDigest = sha256Bytes(bytes);
  if (recomputedDigest === recordedDigest) {
    failures.delete(location);
    return;
  }
  refuse(location, {
    objectKey: digestObjectKey(location),
    objectName: storedObjectName(location),
    recordedDigest,
    recomputedDigest,
    kind: kindFromLabel(label),
  }, options);
}

function queueBlobWrite(job: () => Promise<void>): void {
  const recorded = job().then(
    () => undefined,
    (error: unknown) => (error instanceof Error ? error : new Error("Durable write failed.")),
  );
  pendingList().push(recorded);
}

export function retainBytes(input: { location: string; bytes: Buffer; contentType: string; label: string }): { location: string; sha256: string } {
  const sha256 = sha256Bytes(input.bytes);
  failures.delete(input.location);
  if (isBlobLocation(input.location)) {
    stage.set(input.location, Buffer.from(input.bytes));
    queueBlobWrite(async () => {
      try {
        await blobPutBytes(input.location, input.bytes, true, input.contentType);
        const stored = await blobGetBytes(input.location);
        if (!stored) throw new Error("Durable write failed.");
        assertStoredDigest(input.location, stored, sha256, input.label, { recordAudit: false });
        stage.set(input.location, Buffer.from(stored));
      } catch (error) {
        stage.delete(input.location);
        throw error;
      }
    });
    return { location: input.location, sha256 };
  }
  getStorage().write(input.location, input.bytes);
  const stored = Buffer.from(getStorage().read(input.location));
  assertStoredDigest(input.location, stored, sha256, input.label, { recordAudit: false });
  return { location: input.location, sha256 };
}

export function discardRetained(location: string): void {
  stage.delete(location);
  failures.delete(location);
  if (!isBlobLocation(location) && getStorage().exists(location)) getStorage().remove(location);
}

export function objectPresent(location: string): boolean {
  if (isBlobLocation(location)) return stage.has(location) || failures.has(location);
  return getStorage().exists(location);
}

/** Bytes on disk or in Blob, with no digest check and no audit row. */
export async function readStoredBytesUnchecked(location: string): Promise<Buffer | null> {
  if (isBlobLocation(location)) {
    const stored = await blobGetBytes(location);
    return stored ? Buffer.from(stored) : null;
  }
  if (!getStorage().exists(location)) return null;
  return Buffer.from(getStorage().read(location));
}

export function readRetainedSync(location: string, expected: string | undefined, label: string, options?: RetainedReadOptions): Buffer | null {
  // Directory bytes are available now; compare the current bytes on every read.
  // Blob callers use the fact from request scoped hydration of the staged object.
  if (isBlobLocation(location) && !options?.bypassCache) {
    const fact = failures.get(location);
    if (fact) refuse(location, fact, options);
  }
  if (isBlobLocation(location)) {
    const staged = stage.get(location);
    if (!staged) return null;
    const bytes = Buffer.from(staged);
    assertStoredDigest(location, bytes, expected, label, options);
    return bytes;
  }
  if (!getStorage().exists(location)) return null;
  const bytes = Buffer.from(getStorage().read(location));
  assertStoredDigest(location, bytes, expected, label, options);
  return bytes;
}

export function readVerified(location: string, expected: string | undefined, label: string, options?: RetainedReadOptions): Buffer {
  const bytes = readRetainedSync(location, expected, label, options);
  if (!bytes) throw new AegisError("NOT_FOUND", `${label} has not been written.`, 404);
  return bytes;
}

export async function readRetained(location: string, expected: string | undefined, label: string, options?: RetainedReadOptions): Promise<Buffer | null> {
  if (isBlobLocation(location)) {
    const stored = await blobGetBytes(location);
    if (!stored) {
      stage.delete(location);
      return null;
    }
    try {
      assertStoredDigest(location, stored, expected, label, options);
    } catch (error) {
      stage.delete(location);
      if (error instanceof AegisError && error.code === DIGEST_MISMATCH_CODE) await flushRetainedWrites();
      throw error;
    }
    failures.delete(location);
    stage.set(location, Buffer.from(stored));
    return Buffer.from(stored);
  }
  return readRetainedSync(location, expected, label, options);
}

export async function flushRetainedWrites(): Promise<void> {
  const jobs = pendingList().splice(0, pendingList().length);
  if (jobs.length === 0) return;
  const results = await Promise.all(jobs);
  const failure = results.find((item) => item instanceof Error);
  if (failure) throw failure;
}

export function locateWorkspaceEvidence(root: string, href: string, ownerKey?: string): string | null {
  const trimmed = href.trim();
  if (!trimmed.startsWith("workspace-evidence/")) return null;
  if (blobEnabled(ownerKey)) {
    const relative = trimmed.slice("workspace-evidence/".length).split("/").filter(Boolean);
    if (relative.length === 0) return null;
    try {
      return evidenceBlobKey(ownerKey!, ...relative);
    } catch {
      return null;
    }
  }
  return resolveEvidenceHref(root, trimmed);
}

async function loadUnverified(location: string, label: string): Promise<void> {
  await readRetained(location, undefined, label, { recordAudit: false });
}

async function loadOne(location: string, expected: string, label: string): Promise<void> {
  try {
    await readRetained(location, expected, label, { recordAudit: false });
  } catch (error) {
    if (error instanceof AegisError && error.code === DIGEST_MISMATCH_CODE) return;
    throw error;
  }
}

/** Reload stored evidence and exports from the Blob store and recompute each digest. */
export async function refreshRetained(state: PersistedState, root: string, ownerKey: string): Promise<void> {
  if (!blobEnabled(ownerKey)) return;
  const jobs: Promise<void>[] = [];
  for (const control of state.controls) {
    for (const item of control.evidence) {
      if (!item.href.startsWith("workspace-evidence/")) continue;
      const location = locateWorkspaceEvidence(root, item.href, ownerKey);
      if (!location) continue;
      jobs.push(item.sha256 ? loadOne(location, item.sha256, "Evidence file") : loadUnverified(location, "Evidence file"));
    }
  }
  for (const item of state.exports) {
    if (!item.filePath || !isBlobLocation(item.filePath)) continue;
    jobs.push(item.sha256 ? loadOne(item.filePath, item.sha256, "Export") : loadUnverified(item.filePath, "Export"));
  }
  for (const render of [state.renders.word, state.renders.excel]) {
    if (!render?.filePath || !isBlobLocation(render.filePath)) continue;
    jobs.push(render.sha256 ? loadOne(render.filePath, render.sha256, "Export") : loadUnverified(render.filePath, "Export"));
  }
  await Promise.all(jobs);
}

export function resetRetainedForTests(): void {
  stage.clear();
  failures.clear();
  unverified.clear();
  processPending.length = 0;
}
