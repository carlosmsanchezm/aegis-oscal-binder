/** Tab-local map presentation only; evidence remains in its owner-scoped store. */
export type MapSnapshotChoice = { highlighted: boolean; receipt: string | null };
export function parseMapSnapshot(value: string | null): MapSnapshotChoice | null {
  try {
    const choice: unknown = JSON.parse(value ?? "null");
    if (!choice || typeof choice !== "object") return null;
    const { highlighted, receipt } = choice as Record<string, unknown>;
    if (typeof highlighted !== "boolean" || !(receipt === null || typeof receipt === "string" && /^[a-f0-9]{64}$/.test(receipt))) return null;
    return { highlighted, receipt };
  } catch { return null; }
}
