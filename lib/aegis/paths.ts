import { accessSync, constants, existsSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const resolvedDirs = new Map<string, string>();

function writableDir(dir: string): boolean {
  try {
    mkdirSync(dir, { recursive: true });
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function configuredDir(configured: string): string {
  const resolved = path.resolve(configured);
  mkdirSync(resolved, { recursive: true });
  return resolved;
}

/**
 * Writable workspace directory.
 *
 * `AEGIS_DATA_DIR` wins. Otherwise `<repo>/.data` when that path can be
 * created, and `<os tmpdir>/aegis-data` when the app filesystem is read-only.
 * That temp path is local to the process. Inbound releases and session
 * snapshots do not use it when Blob storage is configured.
 */
export function dataDir(root: string): string {
  const configured = process.env.AEGIS_DATA_DIR?.trim() ?? "";
  const key = `${configured}\0${path.resolve(root)}`;
  const cached = resolvedDirs.get(key);
  if (cached) return cached;

  let dir: string;
  if (configured) {
    dir = configuredDir(configured);
  } else {
    const local = path.join(path.resolve(root), ".data");
    if (writableDir(local)) {
      dir = local;
    } else {
      const fallback = path.join(os.tmpdir(), "aegis-data");
      if (!writableDir(fallback)) {
        throw new Error(`No writable data directory. Set AEGIS_DATA_DIR. Tried ${local} and ${fallback}.`);
      }
      dir = fallback;
    }
  }

  resolvedDirs.set(key, dir);
  return dir;
}

export function findRepoRoot(start = process.cwd()): string {
  let dir = path.resolve(start);
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(path.join(dir, "fixtures", "gold", "fixture.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`Could not find fixtures/gold/fixture.json from ${start}`);
}

export function goldEvidenceRoot(root: string): string {
  return path.join(root, "fixtures", "gold", "evidence");
}

/** Resolve an evidence/ or workspace-evidence/ href. Rejects paths that escape the allowed directory. */
export function resolveEvidenceHref(root: string, href: string): string | null {
  const trimmed = href.trim();
  if (trimmed.includes("..") || trimmed.includes("\\") || trimmed.includes("\0")) return null;
  if (trimmed.startsWith("evidence/")) {
    const base = goldEvidenceRoot(root);
    const resolved = path.resolve(root, "fixtures", "gold", trimmed);
    if (resolved !== base && !resolved.startsWith(base + path.sep)) return null;
    return resolved;
  }
  if (trimmed.startsWith("workspace-evidence/")) {
    const base = path.join(dataDir(root), "uploads");
    const relative = trimmed.slice("workspace-evidence/".length);
    if (!relative || relative.startsWith("/") || relative.includes("..")) return null;
    const resolved = path.resolve(base, relative);
    if (resolved !== base && !resolved.startsWith(base + path.sep)) return null;
    return resolved;
  }
  return null;
}
