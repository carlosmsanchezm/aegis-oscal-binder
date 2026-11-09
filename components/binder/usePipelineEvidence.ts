"use client";
import { restoreSelectedPipeline } from "@/lib/client/selected-pipeline";
import { useEffect, useMemo, useRef, useState } from "react";
import { CCM_EXAMPLE, parseCcmSummary, summaryForSession, type PipelineEvidence } from "@/lib/aegis/pipeline-evidence";
import { parseStoredPipelineEvidence, PIPELINE_WEBHOOK_PATH, type PipelineConnection } from "@/lib/aegis/pipeline-inbound";

const INVENTORIES_KEY = "aegis.planning.source-inventories.v1";
const HISTORY_KEY = "aegis.planning.retained-history.v1";
const KEY = "aegis.planning.release.v1";

export type PipelineSeed = {
  evidence: PipelineEvidence | null;
  configured: boolean;
  webhookPath: string;
  receivedAt: string | null;
  releases?: { evidence: PipelineEvidence; receivedAt: string }[];
  storage?: string;
};

function connectionFor(seed: PipelineSeed | undefined): PipelineConnection {
  return {
    configured: seed ? seed.configured : null,
    webhookPath: seed?.webhookPath || PIPELINE_WEBHOOK_PATH,
    receivedAt: seed?.receivedAt ?? null,
    inboundSelected: Boolean(seed?.evidence),
  };
}

export function usePipelineEvidence(enabled: boolean, seed?: PipelineSeed) {
  const seedEvidence = Boolean(seed?.evidence);
  const selectionVersion = useRef(0);
  const [record, setRecord] = useState<PipelineEvidence>(seed?.evidence ?? CCM_EXAMPLE);
  const [connection, setConnection] = useState<PipelineConnection>(connectionFor(seed));
  const [releases, setReleases] = useState<PipelineEvidence[]>(seed?.releases?.map(r => r.evidence) ?? []);
  const [retainedHistory, setRetainedHistory] = useState<PipelineEvidence[]>([]);
  const [captured, setCaptured] = useState<PipelineEvidence[]>([]);
  const received = seed?.releases ?? [];
  useEffect(() => {
    if (!enabled) return;
    try {setRetainedHistory(JSON.parse(sessionStorage.getItem(HISTORY_KEY) ?? "[]").map((item:unknown)=>restoreSelectedPipeline(parseCcmSummary(item))));} catch { /* Invalid retained data is ignored. */ }
    let cancelled = false;
    const version = selectionVersion.current;
    (async () => {
      let sessionRecord: PipelineEvidence | null = null;
      try {
        const value = window.sessionStorage.getItem(KEY);
        if (value) sessionRecord = restoreSelectedPipeline(parseCcmSummary(JSON.parse(value)));
        const inventories = JSON.parse(window.sessionStorage.getItem(INVENTORIES_KEY) ?? "[]");
        if (Array.isArray(inventories) && inventories.length <= 20) setCaptured(inventories.map(item => parseCcmSummary(item)).filter(item => item.sourceInventoryHref && item.collectedArtifacts?.length));
        if (sessionRecord && selectionVersion.current === version) setRecord(sessionRecord);
      } catch { /* Invalid or blocked session storage leaves the current release unchanged. */ }
      try {
        const response = await fetch(PIPELINE_WEBHOOK_PATH, { cache: "no-store" });
        if (!response.ok || cancelled) return;
        const body = await response.json() as Record<string, unknown>;
        if (cancelled) return;
        const nextConnection: PipelineConnection = {
          configured: body.configured === true,
          webhookPath: typeof body.webhookPath === "string" && body.webhookPath.startsWith("/") ? body.webhookPath : PIPELINE_WEBHOOK_PATH,
          receivedAt: typeof body.receivedAt === "string" ? body.receivedAt : null,
          inboundSelected: false,
        };
        if (body.evidence) {
          const evidence = parseStoredPipelineEvidence(body.evidence);
          const history = Array.isArray(body.releases) ? body.releases.map(r => parseStoredPipelineEvidence((r as { evidence: unknown }).evidence)) : [evidence];
          setReleases(history);
          const preferred = sessionRecord && history.find(r => r.pipelineUrl === sessionRecord!.pipelineUrl && r.commitSha === sessionRecord!.commitSha && r.releaseSha256 === sessionRecord!.releaseSha256);
          const restoredPreferred = preferred && sessionRecord?.collectedArtifacts ? {...preferred,collectedArtifacts:sessionRecord.collectedArtifacts} : preferred;
          const chosen = restoredPreferred ?? (sessionRecord?.pipelineUrl === CCM_EXAMPLE.pipelineUrl ? sessionRecord : evidence);
          if (cancelled) return;
          if (selectionVersion.current !== version) {setConnection(current=>({...nextConnection,inboundSelected:current.inboundSelected}));return;}
          setRecord(chosen);
          setConnection({ ...nextConnection, inboundSelected: chosen.source === "Inbound pipeline event" });
          return;
        }
        setConnection(nextConnection);
        if (selectionVersion.current !== version) return;
        setRecord(sessionRecord ?? CCM_EXAMPLE);
      } catch {
        if (!cancelled && selectionVersion.current === version && !seedEvidence && sessionRecord) setRecord(sessionRecord);
      }
    })();
    return () => { cancelled = true; };
  }, [enabled, seedEvidence]);
  function update(next: PipelineEvidence) {
    selectionVersion.current += 1;
    setRecord(next);
    if (next.sourceInventoryHref && next.collectedArtifacts?.length) setCaptured(current => {
      const updated = [...current.filter(item => item.sourceInventoryHref !== next.sourceInventoryHref), next].slice(-20);
      if (enabled) try {window.sessionStorage.setItem(INVENTORIES_KEY, JSON.stringify(updated.map(summaryForSession)));} catch { /* Retained in memory when storage is unavailable. */ }
      return updated;
    });
    setConnection((current) => ({ ...current, inboundSelected: next.source === "Inbound pipeline event", receivedAt: received.find(r => r.evidence.pipelineUrl === next.pipelineUrl)?.receivedAt ?? current.receivedAt }));
    if (enabled) {
      try { window.sessionStorage.setItem(KEY, JSON.stringify(summaryForSession(next))); } catch { /* In-memory review still works. */ }
    }
  }
  function retainHistory(records: PipelineEvidence[]) {
    setRetainedHistory(current => {
      const next = [...new Map([...current, ...records].map(record => [JSON.stringify([record.pipelineUrl, record.commitSha, record.releaseSha256]), record])).values()];
      if (enabled) try {sessionStorage.setItem(HISTORY_KEY, JSON.stringify(next.map(summaryForSession)));} catch { /* In memory history remains available. */ }
      return next;
    });
  }
  const allReleases = useMemo<PipelineEvidence[]>(() => [...retainedHistory, ...releases, ...captured], [captured, releases, retainedHistory]);
  return [record, update, connection, allReleases, retainHistory, releases[0]??captured.at(-1)??record] as const;
}
