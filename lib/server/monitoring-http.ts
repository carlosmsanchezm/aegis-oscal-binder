import { authenticatesConnection, builderOwner, ownsConnection, readConnection } from "./builder-store";
import { BuilderRequestError, builderHandler, builderJson } from "./builder-http";
import { canonicalCapture } from "../monitoring/capture";
import { monitoringCopy } from "../monitoring/copy";
import { loadCollectors } from "../monitoring/builtins";
import { verifyTimeline } from "../monitoring/chain";
import { ingestCapture } from "../monitoring/ingest";
import { getCollector } from "../monitoring/registry";
import { canonicalRepo, canonicalTimestamp } from "../monitoring/safety";
import type { ScanTrigger } from "../monitoring/types";
import { listMonitoringRecords, readMonitoringRecord } from "./builder-store";
import type { MonitorTimelineEntry } from "../monitoring/types";

const MAX_BODY = 2_000_000;

async function readBody(req: Request): Promise<unknown> {
  const length = Number(req.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_BODY) throw new BuilderRequestError(monitoringCopy.invalidCapture, 413);
  if (!req.body) throw new BuilderRequestError(monitoringCopy.invalidCapture);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_BODY) { await reader.cancel(); throw new BuilderRequestError(monitoringCopy.invalidCapture, 413); }
    chunks.push(value);
  }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { throw new BuilderRequestError(monitoringCopy.invalidCapture); }
}

function triggerFrom(value: unknown, kind: ScanTrigger["kind"]): ScanTrigger {
  if (!value || typeof value !== "object") throw new BuilderRequestError(monitoringCopy.invalidTrigger);
  const body = value as Record<string, unknown>;
  const trigger = body.trigger;
  if (!trigger || typeof trigger !== "object") throw new BuilderRequestError(monitoringCopy.invalidTrigger);
  const row = trigger as Record<string, unknown>;
  if (row.kind !== kind) throw new BuilderRequestError(monitoringCopy.invalidTrigger);
  if (kind === "webhook" && row.event !== "push" && row.event !== "merge") throw new BuilderRequestError(monitoringCopy.invalidTrigger);
  if (kind !== "webhook" && row.event != null) throw new BuilderRequestError(monitoringCopy.invalidTrigger);
  if (typeof row.repo !== "string" || typeof row.revision !== "string" || typeof row.at !== "string") throw new BuilderRequestError(monitoringCopy.invalidTrigger);
  let runId: string | undefined;
  if (row.runId != null) {
    if (typeof row.runId !== "string" || !/^[A-Za-z0-9._-]{1,80}$/.test(row.runId)) throw new BuilderRequestError(monitoringCopy.invalidTrigger);
    runId = row.runId;
  }
  try {
    return { kind, ...(kind === "webhook" ? { event: row.event as "push" | "merge" } : {}), repo: canonicalRepo(row.repo), revision: row.revision, at: canonicalTimestamp(row.at), ...(runId ? { runId } : {}) };
  } catch {
    throw new BuilderRequestError(monitoringCopy.invalidTrigger);
  }
}

function publicMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  const known = new Set<string>(Object.values(monitoringCopy).filter((item): item is string => typeof item === "string"));
  if (known.has(message) || message === "Invalid source capture." || message === "Invalid collected artifact." || message === "Refusing to retain a secret value." || message === "Pilot monitoring limit reached; indexed storage is required." || message === "Monitoring record conflict." || message === "Monitoring record exceeds the storage limit.") return message;
  return monitoringCopy.invalidCapture;
}

export function postMonitoringCapture(req: Request, connectionId: string, kind: "webhook" | "ci"): Promise<Response> {
  return builderHandler(async () => {
    if (!/^[0-9a-f-]{36}$/.test(connectionId)) throw new BuilderRequestError(monitoringCopy.notFound, 404);
    const connection = await readConnection(connectionId);
    const token = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.get("authorization") ?? "")?.[1] ?? null;
    if (!connection || !authenticatesConnection(connection, token)) throw new BuilderRequestError(monitoringCopy.credentialRejected, 401);
    const body = await readBody(req) as Record<string, unknown>;
    const trigger = triggerFrom(body, kind);
    const adapterId = body.adapter == null ? "repo-scanner" : body.adapter;
    if (typeof adapterId !== "string" || !/^[a-z0-9][a-z0-9-]{0,40}$/.test(adapterId)) throw new BuilderRequestError(monitoringCopy.collectorMissing);
    loadCollectors();
    const adapter = getCollector(adapterId);
    if (!adapter) throw new BuilderRequestError(monitoringCopy.collectorMissing);
    if (!adapter.triggers.includes(kind)) throw new BuilderRequestError(monitoringCopy.collectorTrigger);
    let capture;
    try { capture = await adapter.collect({ trigger, capture: body.capture }); }
    catch (error) { throw new BuilderRequestError(publicMessage(error)); }
    if (!capture) throw new BuilderRequestError(monitoringCopy.emptyCollector);
    let stored;
    try { stored = await ingestCapture(connectionId, trigger, canonicalCapture(capture)); }
    catch (error) { throw new BuilderRequestError(publicMessage(error)); }
    const drafts = stored.entries.flatMap(entry => entry.draft ? [{ id: entry.draft.plan.id, control: entry.draft.plan.control, acceptance: entry.draft.decision.acceptance, disposition: entry.draft.plan.assessment.disposition }] : []);
    if (drafts.some(draft => draft.acceptance !== "proposed" || draft.disposition !== "needs-verification")) throw new BuilderRequestError(monitoringCopy.invalidCapture, 500);
    return builderJson({
      ok: true, replayed: stored.replayed, captureSha256: stored.captureSha256, evidenceIds: stored.evidenceIds, drafts,
      drift: stored.drift.map(row => ({ subjectId: row.subjectId, subjectKind: row.subjectKind, drift: row.drift, label: row.label, previous: row.previous, outcome: row.outcome, regression: row.regression, regressionLabel: row.regressionLabel })),
    }, stored.replayed ? 200 : 201);
  });
}

export function readControlTimeline(req: Request, connectionId: string, controlId: string): Promise<Response> {
  return builderHandler(async () => {
    if (!/^[0-9a-f-]{36}$/.test(connectionId) || !/^[A-Za-z0-9][A-Za-z0-9.-]{0,79}$/.test(controlId)) throw new BuilderRequestError(monitoringCopy.notFound, 404);
    const connection = await readConnection(connectionId);
    const token = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.get("authorization") ?? "")?.[1] ?? null;
    const allowed = !!connection && (authenticatesConnection(connection, token) || ownsConnection(connection, builderOwner(req.headers.get("cookie"))));
    if (!connection || !allowed) throw new BuilderRequestError(token ? monitoringCopy.credentialRejected : monitoringCopy.notFound, token ? 401 : 404);
    const names = await listMonitoringRecords(connectionId, "timeline");
    const raw = await Promise.all(names.map(name => readMonitoringRecord(connectionId, "timeline", name)));
    const entries = raw.filter((item): item is string => !!item).map(item => JSON.parse(item) as MonitorTimelineEntry).filter(entry => entry.subjectId.toUpperCase() === controlId.toUpperCase());
    entries.sort((a, b) => a.capturedAt.localeCompare(b.capturedAt) || a.entryHash.localeCompare(b.entryHash));
    const chain = verifyTimeline(entries);
    return builderJson({
      ok: true, controlId: controlId.toUpperCase(),
      chain: { intact: chain.intact, label: chain.intact ? monitoringCopy.chainIntact : monitoringCopy.chainBroken, ...(chain.brokenAt ? { brokenAt: chain.brokenAt } : {}) },
      emptyLabel: entries.length ? "" : monitoringCopy.emptyTimeline,
      entries,
    });
  });
}
