"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { EvidenceConnection } from "@/lib/aegis/connected-evidence";

export function useConnectedEvidence() {
  const [connections, setConnections] = useState<EvidenceConnection[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selectedRef=useRef<string|null>(null);
  const hasChosen=useRef(false);
  const request=useRef(0);
  const pending=useRef<AbortController|null>(null);
  const [sessionNotice,setSessionNotice]=useState<string|null>(null);
  const [now, setNow] = useState(Date.now());
  const [loading, setLoading] = useState(true);
  const [refreshIntervalMs, setRefreshIntervalMs] = useState(60_000);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    // A periodic tick must not cancel a slower read and leave its server work running.
    if(pending.current&&!pending.current.signal.aborted)return;
    const ticket=++request.current, requestedSelection=selectedRef.current;
    const controller=new AbortController();pending.current=controller;
    try {
      let response:Response;
      try{response=await fetch("/api/builder",{cache:"no-store",signal:controller.signal});}
      catch(cause){if(controller.signal.aborted)throw cause;response=await fetch("/api/builder",{cache:"no-store",signal:controller.signal});}
      const body = await response.json();
      if (!response.ok || !body.ok) throw new Error(body.error || "Connected evidence unavailable.");
      if(ticket!==request.current || requestedSelection!==selectedRef.current)return;
      setConnections(body.connections); setRefreshIntervalMs(body.refreshIntervalMs === 3000 ? 3000 : 60_000); setError(null);
      if(!hasChosen.current&&!selectedRef.current){
        const boutique=(body.connections as EvidenceConnection[]).find(c=>c.name === "Online Boutique" && c.history.length && !c.revokedAt);
        if(boutique){selectedRef.current=boutique.id;setSelectedId(boutique.id);}
      }
      if(selectedRef.current && !body.connections.some((c:EvidenceConnection)=>c.id === selectedRef.current)) {
        selectedRef.current=null;setSelectedId(null);
        try {sessionStorage.removeItem("binder.connected-system.v1");} catch {}
        setSessionNotice("Your browser session changed. Reload the workspace, then load a recorded example or connect a system to continue.");
      }
    } catch { if(!controller.signal.aborted && ticket===request.current && requestedSelection===selectedRef.current)setError("Connection paused. Your last loaded evidence is still available. Retry to reconnect."); }
    finally { if(pending.current===controller)pending.current=null;if(ticket===request.current)setLoading(false); }
  }, []);
  useEffect(() => {
    try { const saved=sessionStorage.getItem("binder.connected-system.v1");hasChosen.current=!!saved||sessionStorage.getItem("binder.connected-choice-set.v1")==="1";selectedRef.current=saved;setSelectedId(saved); } catch { /* In-memory selection remains available. */ }
    void refresh();
    return () => {++request.current;pending.current?.abort();};
  }, [refresh]);
  useEffect(() => {
    const timer = setInterval(() => { if (document.visibilityState === "visible") {setNow(Date.now()); void refresh();} }, refreshIntervalMs);
    const onVisible = () => {if (document.visibilityState === "visible") void refresh();};
    document.addEventListener("visibilitychange", onVisible);
    return () => {clearInterval(timer);document.removeEventListener("visibilitychange", onVisible);};
  }, [refresh, refreshIntervalMs]);
  const select = useCallback((id: string | null) => {
    hasChosen.current=true;selectedRef.current=id;setSelectedId(id);setSessionNotice(null);
    try { sessionStorage.setItem("binder.connected-choice-set.v1","1"); if (id) sessionStorage.setItem("binder.connected-system.v1", id); else sessionStorage.removeItem("binder.connected-system.v1"); } catch { /* Keep in-memory choice. */ }
  }, []);
  return { now, connections, selectedId, select, loading, error, sessionNotice, refresh, connection: connections.find(c => c.id === selectedId) ?? null };
}
