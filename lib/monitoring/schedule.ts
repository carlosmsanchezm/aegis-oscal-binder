import { readConnection } from "../server/builder-store";
import { canonicalCapture } from "./capture";
import { monitoringCopy } from "./copy";
import { loadCollectors } from "./builtins";
import { ingestCapture } from "./ingest";
import { listCollectors } from "./registry";

export type ScheduledScanSummary = { connectionId: string; captureSha256: string; regressions: number };

/** Daily cloud scans. Only adapters that implement `scheduledScans` run. */
export async function runScheduledScans(): Promise<ScheduledScanSummary[]> {
  loadCollectors();
  const summaries: ScheduledScanSummary[] = [];
  for (const adapter of listCollectors()) {
    if (!adapter.triggers.includes("schedule") || !adapter.scheduledScans) continue;
    let scans;
    try { scans = await adapter.scheduledScans(new Date().toISOString()); }
    catch { throw new Error(monitoringCopy.scanFailed); }
    for (const scan of scans) {
      if (!(await readConnection(scan.connectionId))) throw new Error(monitoringCopy.scanFailed);
      const stored = await ingestCapture(scan.connectionId, scan.trigger, canonicalCapture(scan.capture));
      summaries.push({ connectionId: scan.connectionId, captureSha256: stored.captureSha256, regressions: stored.drift.filter(row => row.regression).length });
    }
  }
  return summaries;
}
