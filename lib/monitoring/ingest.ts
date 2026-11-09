import {recordCaptureTimeline} from "../timeline/writers";
import { findRepoRoot } from "../aegis/paths";
import { retainEvent, listMonitoringRecords, readMonitoringRecord, writeMonitoringRecord } from "../server/builder-store";
import { canonicalRepo, canonicalTimestamp, assertNoSecrets } from "./safety";
import { monitoringCopy } from "./copy";
import { assertCommitPin, canonicalCapture, captureArtifacts, captureBytes, captureHash } from "./capture";
import { MONITOR_GENESIS, linkEntry, verifyTimeline } from "./chain";
import { classifyOutcomes, outcomesFromArtifacts, type OutcomeSnap } from "./drift";
import { inventoryEvents, regressionDrafts, regressionEvents } from "./problems";
import type { MonitorTimelineEntry, ScanTrigger, SourceCaptureDocument, StoredMonitorResult } from "./types";

function parseEntry(raw: string): MonitorTimelineEntry {
  const entry = JSON.parse(raw) as MonitorTimelineEntry;
  if (!entry || entry.captureSchema !== "aegis.source-capture.v1" || typeof entry.entryHash !== "string" || typeof entry.prevHash !== "string") throw new Error(monitoringCopy.chainRefused);
  return entry;
}

async function loadEntries(connectionId: string, root: string): Promise<MonitorTimelineEntry[]> {
  const names = await listMonitoringRecords(connectionId, "timeline", root);
  const raw = await Promise.all(names.map(name => readMonitoringRecord(connectionId, "timeline", name, root)));
  return raw.filter((item): item is string => !!item).map(parseEntry);
}

function priorOutcomes(entries: MonitorTimelineEntry[], sourceId: string): { outcomes: Map<string, OutcomeSnap>; heads: Map<string, MonitorTimelineEntry>; latest: number } {
  const relevant = entries.filter(entry => entry.sourceId === sourceId);
  const referenced = new Set(relevant.map(entry => entry.prevHash));
  const heads = new Map<string, MonitorTimelineEntry>();
  for (const entry of relevant) {
    if (referenced.has(entry.entryHash)) continue;
    heads.set(`${entry.subjectKind}:${entry.subjectId}`, entry);
  }
  const outcomes = new Map<string, OutcomeSnap>();
  for (const [key, head] of heads) {
    if (head.outcome !== "pass" && head.outcome !== "fail") continue;
    outcomes.set(key, { id: head.subjectId, kind: head.subjectKind, outcome: head.outcome, artifacts: head.artifactNames });
  }
  const latest = Math.max(0, ...[...heads.values()].map(head => Date.parse(head.capturedAt)));
  return { outcomes, heads, latest };
}

async function retainBuiltEvents(connectionId: string, trigger: ScanTrigger, document: SourceCaptureDocument, hash: string, rows: StoredMonitorResult["drift"], root: string): Promise<void> {
  const capture = document.captures[0];
  if (!capture) return;
  const events = [...regressionEvents(trigger, capture.source.capturedAt, hash, canonicalRepo(capture.source.repo), rows), ...inventoryEvents(capture.artifacts)];
  for (const event of events) await retainEvent(connectionId, event.rawEvent, root, "connection-token",false,false);
}

async function persistEntries(connectionId: string, entries: MonitorTimelineEntry[], root: string): Promise<void> {
  for (const entry of entries) {
    assertNoSecrets(JSON.stringify(entry));
    await writeMonitoringRecord(connectionId, "timeline", entry.entryHash, JSON.stringify(entry), root);
  }
}

/** Compare a source capture with the previous one for each system/source and append the timeline. */
export async function ingestCapture(connectionId: string, trigger: ScanTrigger, input: SourceCaptureDocument, root = findRepoRoot()): Promise<StoredMonitorResult> {
  const document = canonicalCapture(input);
  assertCommitPin(document, trigger.revision);
  const body = captureBytes(document);
  assertNoSecrets(body);
  assertNoSecrets(JSON.stringify(trigger));
  for (const capture of document.captures) {
    if (Date.parse(capture.source.capturedAt) > Date.now() + 300_000) throw new Error(monitoringCopy.futureCapture);
  }
  const repo = canonicalRepo(trigger.repo);
  const repos = document.captures.map(capture => canonicalRepo(capture.source.repo));
  if (new Set(repos).size !== repos.length) throw new Error(monitoringCopy.invalidCapture);
  if (document.captures.some(capture => canonicalRepo(capture.source.repo) !== repo || capture.source.commit !== trigger.revision)) throw new Error(monitoringCopy.commitMismatch);
  const hash = captureHash(document);
  const existing = await readMonitoringRecord(connectionId, "results", hash, root);
  if (existing) {
    const stored = JSON.parse(existing) as StoredMonitorResult;
    await persistEntries(connectionId, stored.entries, root);
    await retainBuiltEvents(connectionId, trigger, document, hash, stored.drift, root);
    await indexCapture(connectionId,document,stored,root);
    return { ...stored, replayed: true };
  }
  const history = await loadEntries(connectionId, root);
  const chain = verifyTimeline(history);
  if (!chain.intact) throw new Error(monitoringCopy.chainRefused);
  const entries: MonitorTimelineEntry[] = [];
  const drift = [];
  const evidence: { id: string; rawEvent: string }[] = [];
  for (const capture of document.captures) {
    const sourceId = canonicalRepo(capture.source.repo);
    const prior = priorOutcomes(history, sourceId);
    if (prior.latest && Date.parse(capture.source.capturedAt) < prior.latest) throw new Error(monitoringCopy.staleCapture);
    const rows = classifyOutcomes(prior.outcomes, outcomesFromArtifacts(capture.artifacts));
    drift.push(...rows);
    const events = regressionEvents(trigger, capture.source.capturedAt, hash, sourceId, rows);
    evidence.push(...events);
    const drafts = regressionDrafts(connectionId, trigger, capture.source.capturedAt, hash, sourceId, capture.source.commit, rows, events);
    for (const row of rows) {
      const draft = drafts.find(item => item.plan.control.toUpperCase() === row.subjectId.toUpperCase());
      const head = prior.heads.get(`${row.subjectKind}:${row.subjectId}`);
      entries.push(linkEntry({
        captureSchema: "aegis.source-capture.v1",
        connectionId, sourceId, subjectId: row.subjectId, subjectKind: row.subjectKind,
        capturedAt: capture.source.capturedAt, outcome: row.outcome, drift: row.drift, label: row.label,
        previous: row.previous, regression: row.regression, regressionLabel: row.regressionLabel,
        captureSha256: hash, artifactNames: row.artifactNames,
        ...(draft ? { problem: draft.problem, draft: { plan: draft.plan, decision: draft.decision } } : {}),
        prevHash: head?.entryHash ?? MONITOR_GENESIS,
      }));
    }
    evidence.push(...inventoryEvents(capture.artifacts));
  }
  const linked = verifyTimeline([...history, ...entries]);
  if (!linked.intact) throw new Error(monitoringCopy.chainRefused);
  const evidenceIds = evidence.map(event => event.id);
  const stored: StoredMonitorResult = { captureSha256: hash, sourceIds: repos, trigger, drift, entries, evidenceIds, replayed: false };
  assertNoSecrets(JSON.stringify(stored));
  await writeMonitoringRecord(connectionId, "captures", hash, body, root);
  await writeMonitoringRecord(connectionId, "results", hash, JSON.stringify({ ...stored, replayed: false }), root);
  await persistEntries(connectionId, entries, root);
  for (const event of evidence) await retainEvent(connectionId, event.rawEvent, root, "connection-token",false,false);
  await indexCapture(connectionId,document,stored,root);
  return stored;
}

async function indexCapture(connectionId:string,document:SourceCaptureDocument,stored:StoredMonitorResult,root:string){
 await recordCaptureTimeline(connectionId,{id:stored.captureSha256,commit:stored.trigger.revision,repo:stored.trigger.repo,observedAt:document.captures[0]?.source.capturedAt??stored.trigger.at,artifacts:captureArtifacts(document),controls:stored.drift.filter(r=>r.subjectKind==="control").map(r=>r.subjectId),regressions:stored.drift.filter(r=>r.regression).length},root);
}

export function triggerAt(value: string): string {
  return canonicalTimestamp(value);
}

export function artifactsOf(document: SourceCaptureDocument) {
  return captureArtifacts(document);
}
