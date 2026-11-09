import { durableStorageConfigured } from "@/lib/durable";
import { emptyPersisted, peekPersisted, type PersistedState } from "@/lib/aegis";
import { findRepoRoot } from "@/lib/aegis/paths";
import { SA1_COOKIE } from "@/lib/aegis/sa1-demo";
import { decodeSa1Snapshot } from "./sa1-snapshot";

function cookieValue(rawCookies: string | null, name: string): string | null {
  for (const part of (rawCookies ?? "").split(";")) {
    const trimmed = part.trim();
    const at = trimmed.indexOf("=");
    if (at > 0 && trimmed.slice(0, at) === name) return trimmed.slice(at + 1) || null;
  }
  return null;
}

/**
 * Planning SSR prefers the durable session, then the authenticated demo snapshot.
 * A missing or temporarily unavailable durable backend must not strand the page.
 */
export async function readPlanningState(
  rawCookies: string | null,
  root = findRepoRoot(),
): Promise<PersistedState> {
  const sid = cookieValue(rawCookies, SA1_COOKIE);
  if (!sid) return emptyPersisted();
  try {
    const durable = await peekPersisted(sid, root);
    if (durable) return durable;
  } catch {
    if (durableStorageConfigured()) return emptyPersisted();
  }
  try {
    return decodeSa1Snapshot(rawCookies, sid) ?? emptyPersisted();
  } catch {
    return emptyPersisted();
  }
}
