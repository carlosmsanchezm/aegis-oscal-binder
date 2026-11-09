import type { ScanTrigger, SourceCaptureDocument } from "./types";

export type TriggerKind = ScanTrigger["kind"];

export type CollectorInput = {
  trigger: ScanTrigger;
  capture: unknown;
};

export type ScheduledScan = {
  connectionId: string;
  trigger: ScanTrigger;
  capture: SourceCaptureDocument;
};

/**
 * Read-only collector plug-in.
 * `cursor/github-repo-connection` registers `github-app`.
 * `cursor/aws-govcloud-reader` registers `aws-govcloud` and implements `scheduledScans`.
 * Both return `aegis.source-capture.v1` documents. Neither copies drift, history, or the gate.
 */
export type CollectorAdapter = {
  id: string;
  triggers: readonly TriggerKind[];
  collect(input: CollectorInput): Promise<SourceCaptureDocument | null>;
  scheduledScans?(now: string): Promise<ScheduledScan[]>;
};

const registry = new Map<string, CollectorAdapter>();

export function registerCollector(adapter: CollectorAdapter): void {
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(adapter.id)) throw new Error("Invalid collector id.");
  if (registry.has(adapter.id)) throw new Error(`Collector ${adapter.id} is already registered.`);
  if (!adapter.triggers.length) throw new Error("Collector has no triggers.");
  registry.set(adapter.id, adapter);
}

export function unregisterCollector(id: string): void {
  registry.delete(id);
}

export function getCollector(id: string): CollectorAdapter | undefined {
  return registry.get(id);
}

export function listCollectors(): CollectorAdapter[] {
  return [...registry.values()];
}
