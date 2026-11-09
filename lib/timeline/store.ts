import type { ItemSource } from "../aegis/item-source";
import { appendLog, readLog, type Chained } from "../immutable-log";
import { storageKey } from "../storage-key";
export type TimelineEntry = {
  schema: "binder.timeline-entry.v1";
  id: string;
  kind:
    | "github-actions-run"
    | "govcloud-reader"
    | "retest"
    | "monitoring-capture"
    | "human-review"
    | "agent-action"
    | "person-action";
  source: { repo?: string; runId?: string; url?: string; accountId?: string };
  commit: string;
  observedAt: string;
  recordedAt: string;
  artifactSha256: string[];
  controls: string[];
  findings: string[];
  collected: boolean;
  source_label?: ItemSource;
  reason_code?: string;
  items?: string[];
  summary: Record<string, number | string | string[]>;
  review?: {
    source_label?: ItemSource;
    identity_verification?: "typed_unverified";
    proposalId: string;
    name: string;
    reason: string;
    at: string;
    stage: "plan" | "closure" | "triage";
    decision: "confirm" | "reject";
    version: string;
  };
};
const prefix = (connectionId: string) =>
  storageKey(["timeline", connectionId]) + "/";
export async function appendTimeline(
  connectionId: string,
  entry: Omit<TimelineEntry, "schema" | "recordedAt">,
  root?: string,
) {
  if (
    !entry.id ||
    !Number.isFinite(Date.parse(entry.observedAt)) ||
    entry.artifactSha256.some((h) => !/^[a-f0-9]{64}$/.test(h))
  )
    throw new Error("Invalid timeline entry.");
  const existing = (
    await readLog<TimelineEntry>(prefix(connectionId), root)
  ).find((x) => x.body.id === entry.id);
  if (existing) {
    if (
      existing.body.commit !== entry.commit ||
      JSON.stringify(existing.body.artifactSha256) !==
        JSON.stringify(entry.artifactSha256) ||
      existing.body.observedAt !== entry.observedAt
    )
      throw new Error(
        "Timeline source identity conflicts with an existing run.",
      );
    return existing;
  }
  return appendLog<TimelineEntry>(
    prefix(connectionId),
    {
      schema: "binder.timeline-entry.v1",
      ...entry,
      recordedAt: new Date().toISOString(),
    },
    (x) => x.id === entry.id,
    root,
  );
}
export async function queryTimeline(
  connectionId: string,
  filter: { control?: string; finding?: string } = {},
): Promise<Chained<TimelineEntry>[]> {
  return (await readLog<TimelineEntry>(prefix(connectionId))).filter(
    (x) =>
      (!filter.control ||
        x.body.controls.includes(filter.control.toUpperCase())) &&
      (!filter.finding || matchesTimelineFinding(x.body, filter.finding)),
  );
}
export async function verifyTimeline(connectionId: string) {
  try {
    const rows = await readLog<TimelineEntry>(prefix(connectionId));
    return {
      valid: true,
      entries: rows.length,
      head: rows.at(-1)?.hash ?? null,
    };
  } catch {
    return { valid: false, error: "Timeline chain verification failed." };
  }
}

export function matchesTimelineFinding(entry: TimelineEntry, id: string) {
  return (
    entry.findings.includes(id) ||
    !!entry.items?.includes(id) ||
    (id.startsWith("proposal:") &&
      entry.findings.includes(id.split(":").at(-1)!))
  );
}
