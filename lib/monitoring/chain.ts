import { createHash } from "node:crypto";
import type { MonitorTimelineEntry } from "./types";

export const MONITOR_GENESIS = "0".repeat(64);

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, sortValue(item)]));
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

export function entryHash(entry: Omit<MonitorTimelineEntry, "entryHash"> & { entryHash?: string }): string {
  const { entryHash: _ignored, ...body } = entry;
  return createHash("sha256").update(canonicalJson(body)).digest("hex");
}

export function linkEntry(entry: Omit<MonitorTimelineEntry, "entryHash">): MonitorTimelineEntry {
  return { ...entry, entryHash: entryHash(entry) };
}

export type ChainCheck = { intact: boolean; brokenAt?: string };

/** Each entry's hash covers its body and the previous entry's hash. Forks and edits fail. */
export function verifyTimeline(entries: MonitorTimelineEntry[]): ChainCheck {
  const groups = new Map<string, MonitorTimelineEntry[]>();
  for (const entry of entries) {
    if (entry.entryHash !== entryHash({ ...entry, entryHash: undefined } as Omit<MonitorTimelineEntry, "entryHash">)) return { intact: false, brokenAt: entry.entryHash };
    const key = `${entry.sourceId}\n${entry.subjectKind}\n${entry.subjectId}`;
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  for (const group of groups.values()) {
    const byHash = new Map(group.map(entry => [entry.entryHash, entry]));
    if (byHash.size !== group.length) return { intact: false, brokenAt: group[0]?.entryHash };
    const referenced = new Map<string, number>();
    for (const entry of group) {
      if (entry.prevHash !== MONITOR_GENESIS && !byHash.has(entry.prevHash)) return { intact: false, brokenAt: entry.entryHash };
      if (entry.prevHash !== MONITOR_GENESIS && byHash.get(entry.prevHash)?.sourceId !== entry.sourceId) return { intact: false, brokenAt: entry.entryHash };
      referenced.set(entry.prevHash, (referenced.get(entry.prevHash) ?? 0) + 1);
      if ((referenced.get(entry.prevHash) ?? 0) > 1) return { intact: false, brokenAt: entry.entryHash };
    }
    const heads = group.filter(entry => !referenced.has(entry.entryHash));
    if (heads.length !== 1) return { intact: false, brokenAt: heads[0]?.entryHash };
    let cursor = heads[0];
    const seen = new Set<string>();
    while (cursor) {
      if (seen.has(cursor.entryHash)) return { intact: false, brokenAt: cursor.entryHash };
      seen.add(cursor.entryHash);
      if (cursor.prevHash === MONITOR_GENESIS) break;
      cursor = byHash.get(cursor.prevHash)!;
    }
    if (seen.size !== group.length) return { intact: false, brokenAt: heads[0].entryHash };
  }
  return { intact: true };
}
