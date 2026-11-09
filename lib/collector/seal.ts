import { createHash } from "node:crypto";
import { readCollectedArtifact } from "./read";
import type { CollectedArtifact } from "./types";

function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Recompute the artifact digest after whitelist projection, including an optional KSI. */
export function sealCollectedArtifact(value: unknown): CollectedArtifact {
  const projected = readCollectedArtifact(value);
  if (!projected) throw new Error("Invalid collected artifact.");
  const { sha256: _claimed, ...safe } = projected;
  const sealed = { ...safe, sha256: digest(JSON.stringify(safe)) };
  const verified = readCollectedArtifact(sealed);
  if (!verified || JSON.stringify(verified) !== JSON.stringify(sealed) || verified.sha256 !== sealed.sha256) throw new Error("Invalid collected artifact.");
  return verified;
}
