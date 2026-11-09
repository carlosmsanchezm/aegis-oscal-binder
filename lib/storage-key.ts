/**
 * Every stored object key is built here.
 * Today the parts are the current ownership layout.
 * An organization segment is added in this function only.
 */
export function storageKey(parts: readonly string[]): string {
  if (parts.length === 0) throw new Error("Refusing a malformed storage key.");
  const clean: string[] = [];
  for (const part of parts) {
    if (typeof part !== "string" || part.length === 0 || part.length > 240) {
      throw new Error("Refusing a malformed storage key.");
    }
    if (part === "." || part === ".." || part.includes("/") || part.includes("\\") || part.includes("\0")) {
      throw new Error("Refusing a malformed storage key.");
    }
    clean.push(part);
  }
  return `aegis/${clean.join("/")}`;
}

const OWNER_RE = /^[a-f0-9]{32}$/;

/** Today the owner is the browser session id. */
export function requireOwnershipKey(ownerKey: string): string {
  if (!OWNER_RE.test(ownerKey)) throw new Error("Refusing a malformed ownership key.");
  return ownerKey;
}

export function evidenceBlobKey(ownerKey: string, ...relative: string[]): string {
  return storageKey(["sessions", requireOwnershipKey(ownerKey), "evidence", ...relative]);
}

export function exportBlobKey(ownerKey: string, name: string): string {
  return storageKey(["sessions", requireOwnershipKey(ownerKey), "exports", name]);
}

/**
 * Report and measurement keys keep this organization segment.
 * Workspace accounts live under `accounts/` and do not change these keys.
 */
export const DEFAULT_ORG = "default";

/**
 * Schema reports and measurements. The organization segment is `default`.
 * Session snapshots, evidence, and exports keep their existing keys.
 */
export function reportBlobKey(ownerKey: string, name: string): string {
  return storageKey(["orgs", DEFAULT_ORG, "sessions", requireOwnershipKey(ownerKey), "reports", name]);
}

export function measurementBlobKey(ownerKey: string, name: string): string {
  return storageKey(["orgs", DEFAULT_ORG, "sessions", requireOwnershipKey(ownerKey), "measurements", name]);
}
