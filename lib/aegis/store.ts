import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { blobGetText, blobPutText, persistenceMode, sessionBlobPath, storageUnconfigured } from "../durable";
import { getStorage } from "../storage";
import { readObject, writeObjectOnce } from "../immutable-log";
import { storageKey } from "../storage-key";
import { emptyPersisted } from "./operations";
import { dataDir, findRepoRoot } from "./paths";
import type { PersistedState } from "./types";

/** httpOnly session id. Package state is keyed by this value, never shared across browsers. */
export const SESSION_COOKIE = "aegis_sid";
export const SESSION_TTL_MS = 2 * 60 * 60 * 1000;
export const SESSION_CAP = 500;

const SESSION_ID_RE = /^[a-f0-9]{32}$/;

type Entry = {
  session: Session;
  expiresAt: number;
  savedAt: number;
};

type Snapshot = {
  savedAt: number;
  state: PersistedState;
};

type Registry = {
  sessions: Map<string, Entry>;
};

/**
 * One registry per Node process. Next can evaluate this module twice; a Map on
 * globalThis keeps those copies pointed at the same sessions. Each entry is one
 * browser session — there is no single shared package.
 */
const registry: Registry = (() => {
  const g = globalThis as unknown as { __aegisSessionRegistry?: Registry };
  if (!g.__aegisSessionRegistry) g.__aegisSessionRegistry = { sessions: new Map() };
  return g.__aegisSessionRegistry;
})();

const requestSession = new AsyncLocalStorage<Session>();

export class Session {
  readonly id: string;
  /**
   * A known session cookie arrived with no snapshot and no live memory.
   * The package was not in the durable store.
   * Cleared when this process commits any state for the cookie.
   */
  orphaned = false;
  /** In-flight snapshot write. Directory writes finish inside `commit`. */
  private pending: Promise<void> = Promise.resolve();
  private persisted: PersistedState;

  private constructor(
    id: string,
    private readonly root: string,
    persisted: PersistedState,
    private readonly cookieOnly = false,
  ) {
    this.id = id;
    this.persisted = persisted;
  }

  static create(id: string, root = findRepoRoot()): Session {
    return new Session(id, root, emptyPersisted());
  }

  get ctx() {
    return { root: this.root, ownerKey: this.id };
  }

  get state(): PersistedState {
    return this.persisted;
  }

  static hydrate(id: string, root: string, persisted: PersistedState): Session {
    return new Session(id, root, persisted);
  }

  static hydrateCookie(id: string, root: string, persisted: PersistedState): Session {
    return new Session(id, root, persisted, true);
  }

  commit(next: PersistedState): PersistedState {
    if (!SESSION_ID_RE.test(this.id)) throw new Error("Refusing to persist a session with a malformed id.");
    if (this.cookieOnly) {
      this.persisted = next;
      this.orphaned = false;
      this.pending = Promise.resolve();
      return next;
    }
    const mode = persistenceMode();
    this.persisted = next;
    this.orphaned = false;
    const savedAt = Date.now();
    const body = JSON.stringify({ savedAt, state: next } satisfies Snapshot);
    const entry = registry.sessions.get(this.id);
    if (entry) entry.savedAt = savedAt;
    if (mode === "directory") {
      getStorage().write(sessionSnapshotPath(this.root, this.id), body);
      this.pending = Promise.resolve();
      return next;
    }
    const pathname = sessionBlobPath(this.id);
    // Session snapshots are rewritten. A short cache bound plus uncached reads
    // keeps a second instance from serving the previous package.
    const write = () => blobPutText(pathname, body, true, 60);
    this.pending = this.pending.then(write, write);
    return next;
  }

  flush(): Promise<void> {
    return this.pending;
  }
}

export function sessionPath(root: string): string {
  return path.join(dataDir(root), "workspace.json");
}

function sessionSnapshotPath(root: string, id: string): string {
  return path.join(dataDir(root), "sessions", id, "state.json");
}

async function readSessionSnapshot(root: string, id: string): Promise<Snapshot | null> {
  if (!SESSION_ID_RE.test(id)) return null;
  let raw: string | null;
  try {
    if (persistenceMode() === "blob") {
      raw = await blobGetText(sessionBlobPath(id));
    } else {
      const file = sessionSnapshotPath(root, id);
      raw = getStorage().exists(file) ? getStorage().read(file).toString("utf8") : null;
    }
  } catch (error) {
    if (storageUnconfigured(error)) return null;
    throw error;
  }
  if (raw == null) return null;
  try {
    const parsed = JSON.parse(raw) as Snapshot;
    if (!parsed || typeof parsed.savedAt !== "number" || parsed.state?.version !== 1 || typeof parsed.state.loaded !== "boolean") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function sessionRevocationKey(id: string): string {
  return storageKey(["session-revocations", id + ".json"]);
}

/** End delegated access durably; retained package snapshots are not deleted. */
export async function endSession(id: string | null, root = findRepoRoot()): Promise<void> {
  if (!id || !SESSION_ID_RE.test(id)) return;
  const key = sessionRevocationKey(id);
  if (!(await readObject(key, root))) {
    try {
      await writeObjectOnce(key, { endedAt: new Date().toISOString() }, root);
    } catch (error) {
      // Another sign-out may have created the same immutable marker.
      if (!(await readObject(key, root))) throw error;
    }
  }
  registry.sessions.delete(id);
}

/** Read an active session without adopting it or extending its browser lifetime. */
export async function readActiveSession(id: string, root = findRepoRoot()): Promise<Session | null> {
  if (!SESSION_ID_RE.test(id) || await readObject(sessionRevocationKey(id), root)) return null;
  const nowMs = Date.now();
  const disk = await readSessionSnapshot(root, id);
  const existing = registry.sessions.get(id);
  const memoryFresh = Boolean(existing && existing.expiresAt > nowMs);
  if (!memoryFresh && (!disk || disk.savedAt + SESSION_TTL_MS <= nowMs)) return null;
  if (disk && (!memoryFresh || disk.savedAt > (existing?.savedAt ?? 0))) {
    return Session.hydrate(id, root, disk.state);
  }
  return existing?.session ?? null;
}

/** Drop the in-memory copy only. The stored snapshot remains so the next request can reload it. */
export function dropCachedSession(id: string): void {
  registry.sessions.delete(id);
}

export function outDir(root: string, sessionId?: string): string {
  if (sessionId && SESSION_ID_RE.test(sessionId)) {
    return path.join(dataDir(root), "sessions", sessionId, "out");
  }
  return path.join(dataDir(root), "out");
}

export function readSessionId(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq);
    if (key !== SESSION_COOKIE) continue;
    const value = trimmed.slice(eq + 1).trim();
    return value || null;
  }
  return null;
}

function evict(nowMs: number): void {
  const sessions = registry.sessions;
  for (const [id, entry] of sessions) {
    if (entry.expiresAt <= nowMs) sessions.delete(id);
  }
  while (sessions.size > SESSION_CAP) {
    const oldest = sessions.keys().next().value;
    if (oldest === undefined) break;
    sessions.delete(oldest);
  }
}

function remember(id: string, session: Session, nowMs: number, savedAt: number): Session {
  const sessions = registry.sessions;
  sessions.delete(id);
  sessions.set(id, { session, expiresAt: nowMs + SESSION_TTL_MS, savedAt });
  evict(nowMs);
  return session;
}

function sessionFromSnapshot(id: string, root: string, snapshot: Snapshot, nowMs: number): Session {
  return remember(id, Session.hydrate(id, root, snapshot.state), nowMs, snapshot.savedAt);
}

/**
 * Bind a request to a session. A missing or malformed cookie gets a new id
 * (`fresh`) and never reads another session's package. A known id refreshes
 * its TTL. A known id with a newer stored snapshot reloads that package.
 * An unknown well-formed id with no snapshot starts empty under that id.
 */
export async function adoptSession(cookieHeader: string | null, root = findRepoRoot()): Promise<{ id: string; session: Session; fresh: boolean }> {
  const nowMs = Date.now();
  evict(nowMs);
  const requested = readSessionId(cookieHeader);
  if (requested && SESSION_ID_RE.test(requested)) {
    const disk = await readSessionSnapshot(root, requested);
    const existing = registry.sessions.get(requested);
    const memoryFresh = Boolean(existing && existing.expiresAt > nowMs);
    if (disk && (!memoryFresh || disk.savedAt > (existing?.savedAt ?? 0))) {
      return { id: requested, session: sessionFromSnapshot(requested, root, disk, nowMs), fresh: false };
    }
    if (memoryFresh && existing) {
      return { id: requested, session: remember(requested, existing.session, nowMs, existing.savedAt), fresh: false };
    }
    const session = Session.create(requested, root);
    session.orphaned = true;
    remember(requested, session, nowMs, 0);
    return { id: requested, session, fresh: false };
  }
  const id = randomBytes(16).toString("hex");
  const session = Session.create(id, root);
  remember(id, session, nowMs, 0);
  return { id, session, fresh: true };
}

/** Encrypted planning cookies are the isolated fallback when durable storage is unavailable. */
export function adoptCookieSession(
  requestedId: string | null,
  persisted: PersistedState | null,
  root = findRepoRoot(),
): { id: string; session: Session; fresh: boolean } {
  const valid = Boolean(requestedId && SESSION_ID_RE.test(requestedId));
  const id = valid ? requestedId! : randomBytes(16).toString("hex");
  return { id, session: Session.hydrateCookie(id, root, persisted ?? emptyPersisted()), fresh: !valid };
}

/** Read a session without creating one. Unknown, expired, and malformed ids return null. */
export async function peekPersisted(id: string | null | undefined, root = findRepoRoot()): Promise<PersistedState | null> {
  if (!id || !SESSION_ID_RE.test(id)) return null;
  const nowMs = Date.now();
  const disk = await readSessionSnapshot(root, id);
  const existing = registry.sessions.get(id);
  const memoryFresh = Boolean(existing && existing.expiresAt > nowMs);
  if (disk && (!memoryFresh || disk.savedAt > (existing?.savedAt ?? 0))) {
    return sessionFromSnapshot(id, root, disk, nowMs).state;
  }
  if (memoryFresh && existing) return existing.session.state;
  return null;
}

export function getSession(): Session {
  const current = requestSession.getStore();
  if (!current) throw new Error("Package session is not bound to this request.");
  return current;
}

export function runWithSession<T>(session: Session, fn: () => T): T {
  return requestSession.run(session, fn);
}

export function sessionCookie(id: string, secure: boolean): string {
  const parts = [
    `${SESSION_COOKIE}=${id}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}
