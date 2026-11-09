import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Persistence for session snapshots, uploads, and export artifacts.
 * The local implementation addresses filesystem paths. An S3-compatible
 * store can replace it later without changing routes or components.
 * Read-only files that ship with the app (catalogs, gold evidence) may
 * also be checked through this interface so callers stay off `node:fs`.
 */
export interface ObjectStorage {
  exists(location: string): boolean;
  /** Reads the object. Throws if it is missing, same as a filesystem read. */
  read(location: string): ReturnType<typeof readFileSync>;
  write(location: string, body: Buffer | string): void;
  remove(location: string): void;
}

export function createLocalFileStorage(): ObjectStorage {
  return {
    exists(location) {
      return existsSync(location);
    },
    read(location) {
      return readFileSync(location);
    },
    write(location, body) {
      mkdirSync(path.dirname(location), { recursive: true });
      writeFileSync(location, body);
    },
    remove(location) {
      unlinkSync(location);
    },
  };
}

let active: ObjectStorage | undefined;

export function getStorage(): ObjectStorage {
  if (!active) active = createLocalFileStorage();
  return active;
}
