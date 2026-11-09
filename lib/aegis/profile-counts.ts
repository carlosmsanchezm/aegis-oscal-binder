import { readFileSync } from "node:fs";
import { rev5ProfilePath } from "./map-graph";

type ProfileFile = {
  profile?: {
    imports?: Array<{
      "include-controls"?: Array<{ "with-ids"?: string[] }>;
    }>;
  };
};

let cache: { root: string; ids: string[] } | null = null;

/** Control ids selected by the vendored FedRAMP Rev 5 Moderate profile, in file order. */
export function profileControlIds(root: string): string[] {
  if (cache?.root === root) return cache.ids;
  const file = JSON.parse(readFileSync(rev5ProfilePath(root), "utf8")) as ProfileFile;
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const entry of file.profile?.imports ?? []) {
    for (const include of entry["include-controls"] ?? []) {
      for (const id of include["with-ids"] ?? []) {
        const trimmed = id.trim().toLowerCase();
        if (!trimmed || seen.has(trimmed)) continue;
        seen.add(trimmed);
        ids.push(trimmed);
      }
    }
  }
  cache = { root, ids };
  return ids;
}

/**
 * Base and enhancement counts read from the profile file.
 * An id with a dot is an enhancement. The numbers are not typed at the call site.
 */
export function profileControlCounts(root: string): { total: number; base: number; enhancements: number } {
  const ids = profileControlIds(root);
  let base = 0;
  let enhancements = 0;
  for (const id of ids) {
    if (id.includes(".")) enhancements += 1;
    else base += 1;
  }
  return { total: ids.length, base, enhancements };
}
