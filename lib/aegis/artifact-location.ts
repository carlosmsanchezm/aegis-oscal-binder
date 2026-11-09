import path from "node:path";
import { persistenceMode } from "@/lib/durable";
import { measurementBlobKey, reportBlobKey } from "@/lib/storage-key";
import { dataDir } from "./paths";

/** Object location for a report or measurement. The key always comes from storageKey. */
export function artifactLocation(ownerKey: string, kind: "reports" | "measurements", name: string, root: string): string {
  const key = kind === "reports" ? reportBlobKey(ownerKey, name) : measurementBlobKey(ownerKey, name);
  if (persistenceMode() === "blob") return key;
  return path.join(dataDir(root), key);
}
