import {
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  linkSync,
  unlinkSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  blobGetText,
  blobPutText,
  listBlobPathnames,
  persistenceMode,
} from "./durable";
import { dataDir, findRepoRoot } from "./aegis/paths";
import { canonicalSha256 } from "./collector/aws/jcs";
export async function readObject<T>(
  key: string,
  root = findRepoRoot(),
): Promise<T | null> {
  let raw: string | null;
  if (persistenceMode() === "blob") raw = await blobGetText(key);
  else {
    try {
      raw = readFileSync(path.join(dataDir(root), key), "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }
  return raw === null ? null : (JSON.parse(raw) as T);
}
export async function writeObjectOnce(
  key: string,
  value: unknown,
  root = findRepoRoot(),
) {
  const raw = JSON.stringify(value);
  if (persistenceMode() === "blob") return blobPutText(key, raw, false);
  const file = path.join(dataDir(root), key);
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + "." + randomUUID() + ".tmp";
  writeFileSync(temporary, raw, { flag: "wx", mode: 0o600 });
  try {
    linkSync(temporary, file);
  } finally {
    unlinkSync(temporary);
  }
}
export async function objectKeys(
  prefix: string,
  root = findRepoRoot(),
): Promise<string[]> {
  if (persistenceMode() === "blob")
    return (await listBlobPathnames(prefix))
      .map((x) => x.pathname)
      .filter((key) => key.endsWith(".json"))
      .sort();
  try {
    return readdirSync(path.join(dataDir(root), prefix))
      .filter((x) => x.endsWith(".json"))
      .map((x) => prefix + x)
      .sort();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}
export type Chained<T> = {
  sequence: number;
  prevHash: string;
  hash: string;
  body: T;
};
export const GENESIS = "0".repeat(64);
export async function readLog<T>(
  prefix: string,
  root = findRepoRoot(),
): Promise<Chained<T>[]> {
  const rows = await Promise.all(
    (await objectKeys(prefix, root)).map((k) =>
      readObject<Chained<T>>(k, root),
    ),
  );
  const entries = rows
    .filter((r): r is Chained<T> => !!r)
    .sort((a, b) => a.sequence - b.sequence);
  let previous = GENESIS;
  for (const [i, row] of entries.entries()) {
    const { hash, ...unsigned } = row;
    if (
      row.sequence !== i ||
      row.prevHash !== previous ||
      hash !== canonicalSha256(unsigned)
    )
      throw new Error("Append-only chain verification failed.");
    previous = hash;
  }
  return entries;
}
/** The sequence key is a cross-process compare-and-create slot, including on Blob. */
export async function appendLog<T>(
  prefix: string,
  body: T,
  idempotency: (x: T) => boolean,
  root = findRepoRoot(),
): Promise<Chained<T>> {
  return appendLogComputed(prefix, () => body, idempotency, root);
}
/** Recompute a transition after every lost compare-and-create race. No stale reservation can win. */
export async function appendLogComputed<T>(
  prefix: string,
  compute: (entries: Chained<T>[]) => T,
  idempotency: (x: T) => boolean,
  root = findRepoRoot(),
  unchanged?: (previous:T,next:T)=>boolean,
): Promise<Chained<T>> {
  for (let retry = 0; retry < 20; retry++) {
    const entries = await readLog<T>(prefix, root),
      existing = entries.find((e) => idempotency(e.body));
    if (existing) return existing;
    const body = compute(entries);
    const previous=entries.at(-1);
    if(previous&&unchanged?.(previous.body,body))return previous;
    const unsigned = {
      sequence: entries.length,
      prevHash: entries.at(-1)?.hash ?? GENESIS,
      body,
    };
    const entry = { ...unsigned, hash: canonicalSha256(unsigned) };
    // Logical ISO time orders immutable slots; observed and recorded wall times live in body.
    const key =
      prefix +
      new Date(entries.length).toISOString() +
      "-" +
      unsigned.prevHash +
      ".json";
    try {
      await writeObjectOnce(key, entry, root);
      return entry;
    } catch (e) {
      const raced = await readObject<Chained<T>>(key, root);
      if (!raced) throw e;
    }
  }
  throw new Error("Concurrent append limit reached; retry the request.");
}
