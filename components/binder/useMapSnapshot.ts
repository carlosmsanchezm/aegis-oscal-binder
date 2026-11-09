"use client";
import { useEffect, useRef, useState } from "react";
import { parseMapSnapshot, type MapSnapshotChoice } from "@/lib/client/map-snapshot";

export function useMapSnapshot(scope: string, ready: boolean, defaultHighlighted: boolean) {
  const key = `binder.map-snapshot.v1:${scope}`;
  const fallback: MapSnapshotChoice = { highlighted: defaultHighlighted, receipt: null };
  const [choice, setChoice] = useState<{ key: string; value: MapSnapshotChoice } | null>(null);
  const current = useRef<typeof choice>(null);
  function read(): MapSnapshotChoice {
    try { return parseMapSnapshot(sessionStorage.getItem(key)) ?? fallback; }
    catch { return fallback; }
  }
  useEffect(() => {
    if (!ready) return;
    let saved: MapSnapshotChoice | null = null;
    try { saved = parseMapSnapshot(sessionStorage.getItem(key)); } catch { /* In-memory selection still works. */ }
    const next = { key, value: saved ?? { highlighted: defaultHighlighted, receipt: null } };
    current.current = next;
    setChoice(next);
  }, [key, ready, defaultHighlighted]);
  function update(patch: Partial<MapSnapshotChoice>) {
    // Merge explicit user actions immediately, including two actions in one event.
    const previous = current.current?.key === key ? current.current.value : read();
    const next = { key, value: { ...previous, ...patch } };
    current.current = next;
    setChoice(next);
    try { sessionStorage.setItem(key, JSON.stringify(next.value)); } catch { /* Keep this tab's in-memory choice. */ }
  }
  const value = choice?.key === key ? choice.value : fallback;
  return [value.highlighted, (highlighted: boolean) => update({ highlighted }), value.receipt, (receipt: string | null) => update({ receipt })] as const;
}
