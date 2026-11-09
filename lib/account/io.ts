import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { dataDir, findRepoRoot } from "@/lib/aegis/paths";
import { blobGetText, blobPutText, durableStorageConfigured, persistenceMode, storageUnconfigured } from "@/lib/durable";
import { storageKey } from "@/lib/storage-key";

export function accountKey(...parts: string[]): string {
  return storageKey(["accounts", ...parts]);
}

export function accountStorageConfigured(): boolean {
  return durableStorageConfigured();
}

export function accountStorageMode(): "blob" | "directory" | "unset" {
  if (!durableStorageConfigured()) return "unset";
  return persistenceMode();
}

export async function accountRead(key: string, root = findRepoRoot()): Promise<string | null> {
  if (!durableStorageConfigured()) return null;
  try {
    if (persistenceMode() === "blob") return await blobGetText(key);
    try {
      return readFileSync(path.join(dataDir(root), key), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  } catch (error) {
    if (storageUnconfigured(error)) return null;
    throw error;
  }
}

export async function accountWrite(key: string, body: string, root = findRepoRoot()): Promise<void> {
  if (!durableStorageConfigured()) throw new Error("Durable storage is not configured.");
  if (persistenceMode() === "blob") {
    await blobPutText(key, body, true);
    return;
  }
  const file = path.join(dataDir(root), key);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, body, { mode: 0o600 });
}
