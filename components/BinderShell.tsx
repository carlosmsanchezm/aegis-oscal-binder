"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {loadSourceInventory, withSourceInventories} from "@/lib/collector/load-inventory";
import { useMapSnapshot } from "./binder/useMapSnapshot";
import { useConnectedEvidence } from "./binder/useConnectedEvidence";
import { SystemConnections } from "./builder/BuilderWorkspace";
import { connectedReleases } from "@/lib/aegis/connected-evidence";
import { scopeChip } from "@/lib/aegis/map-view";
import type { ArtifactMappingDecision, CatalogId, ChangesReport, ControlView, PackageState } from "@/lib/aegis/types";
import { Term } from "./chrome/Term";
import { WorkspaceNavigation } from "./chrome/WorkspaceNavigation";
import { ChangesPanel } from "./binder/ChangesPanel";
import { ControlPanel, SEPTEMBER_HREF } from "./binder/ControlPanel";
import { downloadOscalArtifact, downloadXmlFile, ExportFlow } from "./binder/ExportFlow";
import { FuturePanel } from "./binder/FuturePanel";
import {capturedMapExample} from "@/lib/aegis/map-metadata";
import { RollupMap, type RollupMapFocus } from "./binder/RollupMap";
import { FixStopwatch } from "./binder/FixStopwatch";
import { PackageMap } from "./binder/PackageMap";
import { artifactFilename, CCM_EXAMPLE, type PipelineEvidence } from "@/lib/aegis/pipeline-evidence";
import { applyAcceptedArtifactMappings, mappingDecision, restoreMappingDecision, evidenceMappingProfile, type ArtifactMappingProposal } from "@/lib/aegis/artifact-mapping";
import { mergeStoredReleases, releasesAtSnapshot, releaseProject } from "@/lib/aegis/control-rollup";
import {RECORDED_EVIDENCE} from "@/lib/aegis/recorded-evidence";
import {workspaceSystemLabel,pipelineSystemName,connectionSystemLabel} from "@/lib/aegis/workspace-label";
import { applyReleaseRollup, releaseSystemName } from "@/lib/aegis/rollup-package";
import { sa1Api, sa1Document, SA1_EVIDENCE, SA1_HEADERS } from "@/lib/aegis/sa1-demo";
import { proposedControlCounts,retainedProposedControlCounts,completeRetainedSources } from "@/lib/aegis/binder-summary";
import type { ArtifactArrivalState } from "./binder/BinderSummary";
import { PipelineEvidenceView } from "./binder/PipelineEvidenceView";
import { DEFAULT_COVERAGE_NAVIGATION, type CoverageNavigation } from "./binder/BaselineCoverage";
import { PlanProposalProvider } from "./binder/PlanProposal";
import { usePipelineEvidence, type PipelineSeed } from "./binder/usePipelineEvidence";

type View = "connections" | "map" | "export" | "changes" | "future" | "release";
type Channel = "panel" | "flow" | "none" | "ingest";

const SAMPLE_FILES: Record<CatalogId, string> = {
  "fedramp-rev5": "sample-oscal-ssp-rev5.json",
  "fedramp-20x": "sample-oscal-ssp-20x.json",
};

const DEV_CHROME_KEY = "aegis.devChrome";
const MAPPING_DECISIONS_KEY = "aegis.planning.mapping-decisions.v1";
const COMPLETENESS_CLAIM =
  "Completeness FAIL means missing required fields or evidence, not an authorization result. Export, Validate, Render, and Baseline run on the loaded package.";

function mapHonesty(pkg: PackageState): string {
  if (pkg.controls.some(control => control.rollupState)) return "Evidence linked = coverage only. Blank = no evidence linked, not a failure.";
  const version = pkg.map.catalogVersion ?? "5.2.0";
  return `Links from the 800-53 Rev ${version} catalog; baseline counts from the FedRAMP Rev5 Moderate profile. FAIL = missing required fields or evidence, not authorization.`;
}

const PACKAGE_NOT_FOUND =
  "This browser's package was not found on the server. Reload the page, or upload the package again.";

function saveOrExportUrl(url: string): boolean {
  return url.includes("/api/oscal/export") || /\/api\/controls\/[^/]+\/save$/.test(url);
}

function failureSentence(code: string | undefined, message: string): string {
  if (
    code === "NO_FIXTURE"
    || code === "SESSION_LOST"
    || message.includes("Load an OSCAL package or the demo sample package first.")
  ) {
    return PACKAGE_NOT_FOUND;
  }
  return message.trim() || "Request failed.";
}

function withHttpStatus(sentence: string, status: number): string {
  const text = sentence.trim() || "Request failed.";
  if (text.includes(`HTTP ${status}`)) return text;
  return `${text} (HTTP ${status}).`;
}

const AC2_IMPLEMENTATION =
  "Accounts provisioned via the IdP with manager approval; inactive accounts disabled after 35 days.";
const CM6_IMPLEMENTATION =
  "Configuration settings are enforced from the signed baseline; deviations require a recorded exception.";

type ApiError = { code: string; message: string; details: unknown };
type NamedError = { code: string; message: string };
type FutureStub = { id: string; title: string; status: string; note: string; live: boolean };
type CachedMappingChoice = ArtifactMappingDecision;

function readCachedMappingChoices(storage: Storage): CachedMappingChoice[] {
  try {
    const parsed = JSON.parse(storage.getItem(MAPPING_DECISIONS_KEY) ?? "[]") as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap(item => {
      if (!item || typeof item !== "object") return [];
      const value = item as Record<string, unknown>;
      if (
        !Array.isArray(value.controls) || typeof value.releaseKey !== "string" || typeof value.artifact !== "string"
        || typeof value.proposalKey !== "string"
        || (value.status !== "accepted" && value.status !== "rejected")
        || typeof value.decidedAt !== "string"
        || !Number.isFinite(Date.parse(value.decidedAt))
      ) return [];
      return [value as unknown as CachedMappingChoice];
    }).slice(-100);
  } catch {
    return [];
  }
}

function mergeMappingDecisions(current: ArtifactMappingDecision[], incoming: ArtifactMappingDecision[]): ArtifactMappingDecision[] {
  const byProposal = new Map(current.map(item => [item.proposalKey, item]));
  let changed = false;
  for (const item of incoming) {
    const previous = byProposal.get(item.proposalKey);
    if (!previous || Date.parse(item.decidedAt) > Date.parse(previous.decidedAt)) {
      byProposal.set(item.proposalKey, item);
      changed = true;
    }
  }
  return changed ? [...byProposal.values()].slice(-100) : current;
}

function cacheMappingDecision(storage: Storage, decision: ArtifactMappingDecision): void {
  const current = readCachedMappingChoices(storage);
  const next = [...current.filter(item => item.proposalKey !== decision.proposalKey), decision].slice(-100);
  storage.setItem(MAPPING_DECISIONS_KEY, JSON.stringify(next));
}

type ApiBody = {
  ok: boolean;
  packageState?: PackageState;
  error?: ApiError;
  changes?: ChangesReport;
  filename?: string;
  xml?: string;
  status?: number;
  stubs?: FutureStub[];
  note?: string;
  liveConnections?: number;
};

export function BinderShell({ initial, buildCommit, sa1Demo = false, initialView = "map", pipelineSeed, rollupShell = null, initialPipelineSelected = false }: { initial: PackageState; buildCommit: string; sa1Demo?: boolean; initialView?: View; pipelineSeed?: PipelineSeed; rollupShell?: PackageState | null; initialPipelineSelected?: boolean }) {
  const [pkg, setPkg] = useState(initial);
  const [packageLoadOpen,setPackageLoadOpen]=useState(false);
  const [recordedIntroSeen,setRecordedIntroSeen]=useState(false);
  useEffect(()=>{try {setRecordedIntroSeen(sessionStorage.getItem("binder.recorded-intro.v1") === "seen");} catch {}},[]);
  useEffect(()=>{if(pkg.loaded)setPackageLoadOpen(false);},[pkg.loaded]);
  const [view, updateView] = useState<View>(initialView);
  const mapFocus = useRef<RollupMapFocus | null>(null);
  const [viewRestored, setViewRestored] = useState(false);
  // Planning aliases share a choice; the direct release route and package editor stay separate.
  const viewStorageKey = `binder.workspace-view.v1:${sa1Demo ? initialView === "release" ? "planning-pipeline" : "planning" : "package"}`;
  const restoredViewToLoad = useRef<View | null>(null);
  const entryView = useRef<View>(initialView);
  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    let saved: string | null = null;
    try { saved = sessionStorage.getItem(viewStorageKey); } catch { /* Navigation still works without storage. */ }
    const reloading = (performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined)?.type === "reload";
    const requested = reloading && saved ? saved : query.get("control") ? "map" : query.get("view") ?? saved;
    const allowed: View[] = ["connections", "map", "export", "changes", "future", ...(sa1Demo ? ["release" as const] : [])];
    const next = allowed.includes(requested as View) ? requested as View : initialView;
    restoredViewToLoad.current = next;
    entryView.current = next;
    setView(next);
    setViewRestored(true);
  }, [viewStorageKey, sa1Demo, initialView]);
  const [mapAllFamilies, setMapAllFamilies] = useState(false);
  const [coverageNavigation, setCoverageNavigation] = useState<CoverageNavigation>(DEFAULT_COVERAGE_NAVIGATION);
  const [legacyRelease, updateLegacyRelease, pipelineConnection, legacyReleases, retainLegacyHistory, receivedRelease] = usePipelineEvidence(sa1Demo, sa1Demo ? pipelineSeed : undefined);
  const connected = useConnectedEvidence();
  const [pipelineSelected, setPipelineState] = useState(initialPipelineSelected);
  const [legacyChoice, setLegacyChoiceState] = useState("pipeline");
  function setLegacyChoice(value:string) {
    setLegacyChoiceState(value);
    try {sessionStorage.setItem("binder.legacy-choice.v1",value);} catch { /* The in memory choice remains available. */ }
  }
  useEffect(() => {try {setLegacyChoiceState(sessionStorage.getItem("binder.legacy-choice.v1") ?? "pipeline");} catch {}}, []);
  const arrivalCounts = useRef(new Map<string, number>());
  const [arrivalRequest, setArrivalRequest] = useState<ArtifactArrivalState["request"]>(null);
  function beginArtifactArrival(receiptIds: string[]) {
    arrivalCounts.current.clear();
    setArrivalRequest(current => ({id: (current?.id ?? 0) + 1, sourceKey: [...new Set(receiptIds)].sort().join(":")}));
  }
  const inventoryLoadVersion=useRef(0);
  const [sourceInventoryLoading,setSourceInventoryLoading]=useState(false);
  const [sourceInventoryError,setSourceInventoryError]=useState("");
  async function loadLegacyRelease(next: PipelineEvidence) {
    const version=++inventoryLoadVersion.current;
    setSourceInventoryLoading(true);setSourceInventoryError("");
    try {
      const referenceSelected = RECORDED_EVIDENCE.some(record => record.pipelineUrl === next.pipelineUrl && record.commitSha === next.commitSha && record.releaseSha256 === next.releaseSha256);
      const references = referenceSelected ? RECORDED_EVIDENCE.filter(record => releaseProject(record.pipelineUrl) === releaseProject(next.pipelineUrl)) : [];
      retainLegacyHistory(references);
      const retained = await Promise.all(mergeStoredReleases([...legacyReleases,...references,next],next.pipelineUrl).filter(item=>item.sourceInventoryHref).map(item=>loadSourceInventory(item)));
      const inventory=retained.find(item=>item.sourceInventoryHref===next.sourceInventoryHref);
      const loaded=withSourceInventories(inventory ? {...next,collectedArtifacts:inventory.collectedArtifacts} : await loadSourceInventory(next),retained);
      if(version !== inventoryLoadVersion.current) return;
      for (const item of retained) updateLegacyRelease(item);
      beginArtifactArrival([loaded.releaseSha256]);
      updateLegacyRelease(loaded);
    } catch {if(version === inventoryLoadVersion.current) setSourceInventoryError("Captured source inventory could not load. Choose the system again to retry.");}
    finally {if(version === inventoryLoadVersion.current) setSourceInventoryLoading(false);}
  }
  const arrival = useMemo(() => ({request: arrivalRequest, counts: arrivalCounts.current}), [arrivalRequest]);
  function setPipelineSelected(selected: boolean) {
    if(!selected) {inventoryLoadVersion.current++;setSourceInventoryLoading(false);setSourceInventoryError("");}
    setPipelineState(selected);
    try { if (selected) sessionStorage.setItem("binder.pipeline-selected.v1", "true"); else sessionStorage.removeItem("binder.pipeline-selected.v1"); } catch { /* In-memory selection remains available. */ }
  }
  useEffect(() => { try { if (sessionStorage.getItem("binder.pipeline-selected.v1") === "true") setPipelineState(true); } catch { /* A fresh browser stays empty. */ } }, []);
  const evidenceSelected = Boolean(connected.connection) || pipelineSelected;
  const planningMap = Boolean(sa1Demo && rollupShell);
  const [mapHighlighted, setMapHighlighted, connectedReceipt, setConnectedReceipt] = useMapSnapshot(
    `${viewStorageKey}:${connected.selectedId ?? "pipeline"}`, !connected.loading,
    Boolean(connected.selectedId) || pipelineSelected || initialView === "release",
  );
  const [origin, setOrigin] = useState("https://binder.local");
  useEffect(() => { setOrigin(window.location.origin); }, []);
  const observationReleases = useMemo(() => connected.connection ? connectedReleases(connected.connection, origin, connected.now) : [], [connected.connection, origin, connected.now]);
  const receivedReleases = connected.connection ? observationReleases : legacyReleases;
  const release = connected.connection ? observationReleases.find(r => r.releaseSha256 === connectedReceipt) ?? observationReleases.findLast(r => r.releaseEvidence) ?? observationReleases.at(-1) ?? legacyRelease : legacyRelease;
  function updateRelease(next: PipelineEvidence) {
    if (next.schema === "aegis.evidence-event.v1") setConnectedReceipt(next.releaseSha256);
    else {
      setPipelineSelected(true);
      updateLegacyRelease(withSourceInventories(next,mergeStoredReleases(legacyReleases,next.pipelineUrl)));
    }
  }
  useEffect(() => { setSelectedId(null); setLevel2(false); setPipelineArtifact(null); setCoverageNavigation(DEFAULT_COVERAGE_NAVIGATION); }, [connected.selectedId]);
  const [mappingDecisions, setMappingDecisions] = useState<ArtifactMappingDecision[]>([]);
  const [mappingTabFallback, setMappingTabFallback] = useState(false);
  const [mappingStorageNote, setMappingStorageNote] = useState<string | null>(null);
  const returnRelease = useRef<typeof release | null>(null);
  const [pipelineArtifact, setPipelineArtifact] = useState<string | null>(null);
  const releaseLinkApplied = useRef(false);
  useEffect(() => {
    if (releaseLinkApplied.current || connected.loading) return;
    const query = new URLSearchParams(window.location.search);
    const connectionId = query.get("connection"), releaseId = query.get("release");
    if (!connectionId || !releaseId) {releaseLinkApplied.current = true; return;}
    if (!connected.connections.some(c => c.id === connectionId && !c.revokedAt)) return;
    if (connected.selectedId !== connectionId) {connected.select(connectionId); return;}
    const target = observationReleases.find(r => r.pipelineId === releaseId && r.releaseEvidence);
    if (target) {setConnectedReceipt(target.releaseSha256); setView("release"); releaseLinkApplied.current = true;}
  }, [connected.loading, connected.connections, connected.selectedId, connected.select, observationReleases]);

  const queryApplied = useRef(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mapFocusRequest,setMapFocusRequest]=useState(0);
  const [level2, setLevel2] = useState(false);
  const [itemId, setItemId] = useState<string | null>(null);
  const [mapReturn, setMapReturn] = useState(false);
  function setView(next: View) {
    // Persist in the navigation action so an immediate reload cannot beat an effect.
    try {sessionStorage.setItem(viewStorageKey,next);} catch { /* In-memory navigation remains available. */ }
    if (next !== view && pipelineSelected) {
      setRecordedIntroSeen(true);
      try {sessionStorage.setItem("binder.recorded-intro.v1","seen");} catch {}
    }
    if (view === "map" && next !== "map" && mapFocus.current) {
      setSelectedId(mapFocus.current.controlId);
      setLevel2(mapFocus.current.level2);
      setItemId(mapFocus.current.itemId);
    }
    updateView(next);
  }
  function navigateView(next: View) {
    if (next === "release") {
      if (view === "map") setMapReturn(true);
      if (returnRelease.current) { updateRelease(returnRelease.current); returnRelease.current = null; }
    }
    setView(next);
  }
  const [implementation, setImplementation] = useState("");
  const [role, setRole] = useState("");
  const [extraRoles, setExtraRoles] = useState<string[]>([]);
  const [title, setTitle] = useState("");
  const [type, setType] = useState("Document");
  const [href, setHref] = useState("");
  const [fieldsOpen, setFieldsOpen] = useState(true);
  const [evidenceFormOpen, setEvidenceFormOpen] = useState(false);
  const [panelError, setPanelError] = useState<string | null>(null);
  const [panelProblems, setPanelProblems] = useState<string[]>([]);
  const [flowError, setFlowError] = useState<string | null>(null);
  const [changes, setChanges] = useState<ChangesReport | null>(null);
  const [stubs, setStubs] = useState<FutureStub[]>([]);
  const [stubsLoaded, setStubsLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const catalogRef = useRef<CatalogId | "">(initial.catalog.id ?? "");
  const pkgTicket = useRef(0);
  const catalogPending = useRef<Promise<boolean> | null>(null);
  const [pendingCatalog, setPendingCatalog] = useState<CatalogId | "">("");
  const [devChrome, setDevChrome] = useState(false);
  const [ingestError, setIngestError] = useState<NamedError | null>(null);
  const [stagedSample, setStagedSample] = useState<string | null>(null);
  const [stagingSample, setStagingSample] = useState(false);
  const [oscalFileReady, setOscalFileReady] = useState(false);
  const ingestBusy = busy || stagingSample;
  const [synced, setSynced] = useState(false);
  const [partialSavedId, setPartialSavedId] = useState<string | null>(null);
  const oscalRef = useRef<HTMLInputElement>(null);
  const csvRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const ready = Boolean(oscalRef.current?.files?.length);
    setOscalFileReady(ready);
    if (!ready) setStagedSample(null);
  }, [view, packageLoadOpen, pkg.loaded]);
  function onOscalFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    setOscalFileReady(Boolean(event.currentTarget.files?.length));
    setStagedSample(null);
  }


  const mappingCatalogId = pkg.catalog.id ?? "fedramp-rev5";
  const mappingScope = useMemo(() => evidenceMappingProfile(mappingCatalogId, pkg.controls.map(control => control.id)), [mappingCatalogId, pkg.controls]);
  const mappingControlIds = mappingScope.controlIds;
  const activeMappingDecisions = useMemo(() => mappingDecisions.filter(decision => decision.profile?.catalogId === mappingCatalogId && Array.isArray(decision.controls) && decision.controls.every(id => mappingControlIds.includes(id))), [mappingDecisions, mappingCatalogId, mappingControlIds]);
  const mappedRelease = useMemo(() => applyAcceptedArtifactMappings(release, activeMappingDecisions), [release, activeMappingDecisions]);
  const mappedReceivedReleases = useMemo(
    () => receivedReleases.map(item => applyAcceptedArtifactMappings(item, activeMappingDecisions)),
    [receivedReleases, activeMappingDecisions],
  );
  const storedMapReleases = useMemo(() => !evidenceSelected || connected.connection && !observationReleases.length ? [] : mergeStoredReleases([...mappedReceivedReleases, mappedRelease], mappedRelease.pipelineUrl), [evidenceSelected, mappedReceivedReleases, mappedRelease, connected.connection, observationReleases.length]);
  const snapshotReleases = useMemo(() => releasesAtSnapshot(storedMapReleases, mappedRelease), [storedMapReleases, mappedRelease]);
  const rawMapReleases=useMemo(()=>completeRetainedSources(storedMapReleases,[release,...receivedReleases]),[storedMapReleases,release,receivedReleases]);
  const mapProposalCounts=useMemo(()=>retainedProposedControlCounts(evidenceSelected?rawMapReleases:[],mappingControlIds,mappingCatalogId,activeMappingDecisions),[evidenceSelected,rawMapReleases,mappingControlIds,mappingCatalogId,activeMappingDecisions]);
  const snapshotProposalCounts=useMemo(()=>evidenceSelected ? proposedControlCounts([rawMapReleases.find(item=>item.releaseSha256===release.releaseSha256)??release],mappingControlIds,mappingCatalogId,activeMappingDecisions) : new Map<string,number>(),[evidenceSelected,rawMapReleases,release,mappingControlIds,mappingCatalogId,activeMappingDecisions]);
  const mapStructure = useMemo(() => planningMap && rollupShell ? applyReleaseRollup(rollupShell, storedMapReleases, pkg.loaded ? pkg : null) : pkg, [planningMap, rollupShell, storedMapReleases, pkg]);
  const viewPkg = useMemo(() => planningMap && rollupShell ? applyReleaseRollup(rollupShell, snapshotReleases, pkg.loaded ? pkg : null) : pkg, [planningMap, rollupShell, snapshotReleases, pkg]);
  const shown = connected.connection && planningMap ? { ...viewPkg, workspaceName: connected.connection.name } : viewPkg;
  const mapAvailable = pkg.loaded || evidenceSelected && planningMap;
  const selected: ControlView | null = useMemo(
    () => shown.controls.find((control) => control.id === selectedId) ?? null,
    [shown.controls, selectedId],
  );

  useEffect(() => {
    if (!selected) return;
    setImplementation(selected.implementation);
    setRole(selected.responsibleRole);
    setExtraRoles(selected.roleLabels.slice(1));
    setTitle("");
    setHref("");
    setType("Document");
    setPanelProblems([]);
    setPanelError(null);
    setFieldsOpen(true);
    setEvidenceFormOpen(false);
    setPartialSavedId(null);
  }, [selectedId]); // eslint-disable-line react-hooks/exhaustive-deps -- reset drafts only when the operator picks another control

  useEffect(() => {
    const devQuery = new URLSearchParams(window.location.search).get("dev") === "1";
    if (devQuery) {
      setDevChrome(true);
      return;
    }
    try {
      setDevChrome(window.localStorage.getItem(DEV_CHROME_KEY) === "1");
    } catch {
      // Private mode can block localStorage. Developer details stay off.
    }
  }, []);

  useEffect(() => {
    if (!sa1Demo || !synced || !mappingTabFallback || !mappingControlIds.length) return;
    const choices = readCachedMappingChoices(window.sessionStorage);
    if (!choices.length) return;
    const records = [...new Map([CCM_EXAMPLE, ...receivedReleases, release].map(record => [
      JSON.stringify([record.pipelineUrl, record.commitSha, record.releaseSha256]),
      record,
    ])).values()];
    const restored = records.flatMap(record => choices.flatMap(choice => {
      const restored = choice.profile?.catalogId === mappingCatalogId && Array.isArray(choice.profile.controlIds) && choice.controls.every(id => mappingControlIds.includes(id))
        ? restoreMappingDecision(choice, record, choice.profile.controlIds, mappingCatalogId) : null;
      return restored ? [restored] : [];
    }));
    setMappingDecisions(current => mergeMappingDecisions(current, restored));
  }, [sa1Demo, synced, mappingTabFallback, mappingControlIds, mappingCatalogId, receivedReleases, release]);

  useEffect(() => {
    if (!sa1Demo || !synced) return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(sa1Api("/api/pipeline/mappings"), { cache: "no-store", headers: {...SA1_HEADERS, "x-aegis-mapping-scope": "catalog"} });
        const body = await response.json() as { ok?: boolean; decisions?: ArtifactMappingDecision[]; error?: { code?: string; details?: { storageUnset?: boolean } } };
        if (cancelled) return;
        if (response.ok && body.ok && Array.isArray(body.decisions)) {
          setMappingDecisions(current => mergeMappingDecisions(current, body.decisions!));
          setMappingTabFallback(false);
          setMappingStorageNote(null);
        } else if (body.error?.code === "DEMO_CONFIGURATION" && body.error.details?.storageUnset) {
          setMappingTabFallback(true);
          setMappingStorageNote("Server session storage is unavailable. Accept and Reject choices will be retained in this browser tab.");
        } else {
          setMappingTabFallback(false);
          setMappingStorageNote("Server storage could not be read. Review choices cannot be saved until it recovers.");
        }
      } catch {
        if (!cancelled) setMappingStorageNote("Could not reach server storage. Review choices cannot be saved until it recovers.");
      }
    })();
    return () => { cancelled = true; };
  }, [sa1Demo, synced, mappingScope]);

  function rawRelease(next: PipelineEvidence): PipelineEvidence {
    return [release, ...receivedReleases, CCM_EXAMPLE].find(candidate =>
      candidate.pipelineUrl === next.pipelineUrl
      && candidate.commitSha === next.commitSha
      && candidate.releaseSha256 === next.releaseSha256,
    ) ?? next;
  }

  async function decideArtifactMapping(proposal: ArtifactMappingProposal, status: "accepted" | "rejected", controls?: string[], reviewer?: string, source: PipelineEvidence = release): Promise<void> {
    let saved: ArtifactMappingDecision | null = null;
    let serverSaved = false;
    let apiError: Error | null = null;
    try {
      const response = await fetch(sa1Api("/api/pipeline/mappings"), {
        method: "POST",
        cache: "no-store",
        headers: { ...SA1_HEADERS, "content-type": "application/json" },
        body: JSON.stringify({ scope: "catalog", proposalKey: proposal.key, profile: proposal.profile, status, controls, reviewer }),
      });
      const body = await response.json() as { ok?: boolean; decision?: ArtifactMappingDecision; error?: { code?: string; message?: string; details?: { storageUnset?: boolean } } };
      if (response.ok && body.ok && body.decision) {
        saved = restoreMappingDecision(body.decision, source, mappingControlIds, mappingCatalogId);
        if (!saved) throw new Error("The saved proposal differs from the controls reviewed. Reload and review it again.");
        serverSaved = true;
      } else if (!(body.error?.code === "DEMO_CONFIGURATION" && body.error.details?.storageUnset)) {
        apiError = new Error(body.error?.message || "Could not store the mapping decision.");
      }
    } catch (error) { throw error instanceof Error ? error : new Error("Could not reach the server. The decision was not saved."); }
    if (apiError) throw apiError;
    saved ??= mappingDecision(source, proposal, status, new Date().toISOString(), controls, reviewer);
    try {
      if (!serverSaved) {
        cacheMappingDecision(window.sessionStorage, saved);
        setMappingTabFallback(true);
      }
    } catch {
      if (!serverSaved) throw new Error("Could not save the mapping decision in this browser tab.");
    }
    setMappingDecisions(current => mergeMappingDecisions(current, [saved!]));
    setMappingStorageNote(serverSaved ? null : "Server session storage is unavailable. This decision is retained in this browser tab.");
  }

  // Stored release links focus controls in the available map; they never modify the SSP.
  useEffect(() => {
    if (!sa1Demo || queryApplied.current) return;
    const requested = new URLSearchParams(window.location.search);
    if ((performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined)?.type === "reload" && entryView.current !== "map") { queryApplied.current = true; return; }
    if (requested.get("control") && !mapAvailable) return;
    queryApplied.current = true;
    const query = new URLSearchParams(window.location.search);
    // View restoration above handles entry URLs and reloads; do not reapply a stale view query here.
    if (query.get("details") === "developer") setDevChrome(true);
    const id = query.get("control");
    setPipelineArtifact(query.get("artifact"));
    if (id && viewPkg.controls.some((control) => control.id === id)) {
      setMapFocusRequest(current=>current+1);
      setSelectedId(id);
      if (new URLSearchParams(window.location.search).get("pipeline") === "1") {
        setItemId(null);
        setLevel2(true);
        setView("map");
      }
    }
  }, [sa1Demo, mapAvailable, viewPkg.controls]);

  useEffect(() => {
    let cancel = false;
    const ticket = pkgTicket.current;
    (async () => {
      try {
        const response = await fetch(sa1Demo ? sa1Api("/api/package") : "/api/package", { cache: "no-store", headers: sa1Demo ? SA1_HEADERS : undefined });
        const body = (await response.json()) as ApiBody;
        if (!cancel && ticket === pkgTicket.current && body.ok && body.packageState) {
          const scope=response.headers.get("x-aegis-session-scope");
          if(sa1Demo && scope)try{
            const previous=sessionStorage.getItem("binder.server-session.v1");
            if(previous && previous!==scope){
              for(const key of Object.keys(sessionStorage))if(key.startsWith("binder.")||key.startsWith("aegis."))sessionStorage.removeItem(key);
              connected.select(null);setPipelineState(false);updateView("map");setRecordedIntroSeen(false);
              setSelectedId(null);setLevel2(false);setItemId(null);
            }
            sessionStorage.setItem("binder.server-session.v1",scope);
          }catch{}
          adoptPackage(body.packageState);
        }
      } catch {
        // Keep the server render when the package read fails.
      } finally {
        if (!cancel) setSynced(true);
      }
    })();
    return () => {
      cancel = true;
    };
  }, []);

  async function call(url: string, init?: RequestInit, channel: Channel = "flow"): Promise<ApiBody> {
    setBusy(true);
    try {
      const headers = new Headers(init?.headers);
      if (sa1Demo) headers.set("x-aegis-workspace", "sa1-demo");
      if (init?.body && !(init.body instanceof FormData) && !headers.has("content-type")) {
        headers.set("content-type", "application/json");
      }
      const response = await fetch(sa1Demo ? sa1Api(url) : url, { ...init, headers, cache: "no-store" });
      const tracked = saveOrExportUrl(url);
      let body: ApiBody;
      try {
        body = (await response.json()) as ApiBody;
      } catch {
        const message = tracked
          ? `The server returned an unreadable response. (HTTP ${response.status}).`
          : "The server returned an unreadable response.";
        applyChannelError(channel, message, [], "BAD_RESPONSE");
        return { ok: false, status: response.status, error: { code: "BAD_RESPONSE", message, details: null } };
      }
      if (body.packageState) adoptPackage(body.packageState);
      let message = body.ok ? null : body.error?.message ?? "Request failed";
      if (message && !body.ok && tracked && !response.ok) {
        message = withHttpStatus(failureSentence(body.error?.code, message), response.status);
      }
      const details = body.error?.details;
      const problems = Array.isArray(details)
        ? details.map((item) => (item && typeof item === "object" && "message" in item ? String(item.message) : String(item)))
        : [];
      applyChannelError(channel, message, body.ok ? [] : problems, body.error?.code);
      return { ...body, status: response.status };
    } catch {
      const message = "The request failed before the binder could read it.";
      applyChannelError(channel, message, [], "NETWORK");
      return { ok: false, error: { code: "NETWORK", message, details: null } };
    } finally {
      setBusy(false);
    }
  }

  function clearStalePanel() {
    setPanelError(null);
    setPanelProblems([]);
  }

  function applyChannelError(channel: Channel, message: string | null, problems: string[], code = "REQUEST_FAILED") {
    if (channel === "panel") {
      setPanelError(message);
      setPanelProblems(problems);
    } else if (channel === "flow") {
      setFlowError(message);
    } else if (channel === "ingest") {
      setIngestError(message ? { code, message } : null);
    }
  }

  function focusLoaded(_state: PackageState) {
    setLevel2(false);
    setItemId(null);
    setSelectedId(null);
    setImplementation("");
    setRole("");
    setExtraRoles([]);
    setTitle("");
    setHref("");
    setType("Document");
    setPanelError(null);
    setPanelProblems([]);
    setFlowError(null);
    setView("map");
  }

  function showUploaded(body: ApiBody) {
    if (!body.ok || !body.packageState?.loaded) return;
    focusLoaded(body.packageState);
    setStagedSample(null);
    setOscalFileReady(false);
    if (oscalRef.current) oscalRef.current.value = "";
    if (csvRef.current) csvRef.current.value = "";
  }

  function adoptPackage(next: PackageState) {
    pkgTicket.current += 1;
    catalogRef.current = next.catalog.id ?? "";
    setPkg(next);
  }

  async function chooseCatalog(nextId: string): Promise<boolean> {
    if (nextId !== "fedramp-rev5" && nextId !== "fedramp-20x") return false;
    if (catalogRef.current === nextId) return true;
    const pending = chooseCatalogNow(nextId);
    catalogPending.current = pending;
    try {
      return await pending;
    } finally {
      if (catalogPending.current === pending) catalogPending.current = null;
    }
  }

  async function chooseCatalogNow(nextId: CatalogId): Promise<boolean> {
    setPendingCatalog(nextId);
    setIngestError(null);
    const body = await call("/api/catalogs/select", { method: "POST", body: JSON.stringify({ catalog: nextId }) }, "ingest");
    const confirmed = Boolean(body.ok && body.packageState?.catalog.id === nextId);
    setPendingCatalog("");
    if (!confirmed) catalogRef.current = body.packageState?.catalog.id ?? catalogRef.current;
    return confirmed;
  }

  async function useSample() {
    setStagingSample(true);
    setOscalFileReady(false);
    setStagedSample(null);
    setIngestError(null);
    if (oscalRef.current) oscalRef.current.value = "";
    try {
      if (catalogPending.current) {
        const selected = await catalogPending.current;
        if (!selected) return;
      }
      const target: CatalogId = catalogRef.current === "fedramp-20x" ? "fedramp-20x" : "fedramp-rev5";
      if (catalogRef.current !== target) {
        const selected = await chooseCatalog(target);
        if (!selected) return;
      }
      const filename = SAMPLE_FILES[target];
      const response = await fetch(`/samples/${filename}`, { cache: "no-store" });
      if (!response.ok) throw new Error("missing sample");
      const blob = await response.blob();
      const file = new File([blob], filename, { type: "application/json" });
      const transfer = new DataTransfer();
      transfer.items.add(file);
      const input = oscalRef.current;
      if (!input) throw new Error("missing input");
      input.files = transfer.files;
      setOscalFileReady(true);
      setStagedSample(filename);
    } catch {
      setStagedSample(null);
      setIngestError({
        code: "SAMPLE_UNAVAILABLE",
        message: "Could not stage the sample in the file input.",
      });
    } finally {
      // Do not reopen upload until file assignment (or an explicit error) has finished.
      setStagingSample(false);
    }
  }

  async function loadSa1(stayInExport = false) {
    if (catalogRef.current !== "fedramp-rev5" && !(await chooseCatalog("fedramp-rev5"))) return;
    const body = await call("/api/oscal/ingest", { method: "POST", body: JSON.stringify({
      catalog: "fedramp-rev5", filename: "internal-planning-ssp.json", document: sa1Document(),
    }) }, "ingest");
    if (stayInExport && body.ok && body.packageState) adoptPackage(body.packageState); else showUploaded(body);
    if (body.ok && evidenceSelected) setMapHighlighted(true);
  }

  function prepareSa1Evidence() {
    setTitle(SA1_EVIDENCE.title);
    setType(SA1_EVIDENCE.type);
    setHref(SA1_EVIDENCE.href);
    setEvidenceFormOpen(false);
    clearStalePanel();
  }

  async function uploadPackage(kind: "oscal" | "csv") {
    // Staging has its own visible status; never import the previous file mid-stage.
    if (kind === "oscal" && stagingSample) return;
    if (catalogPending.current) {
      const selected = await catalogPending.current;
      if (!selected) return;
    }
    const catalogId = catalogRef.current;
    if (catalogId !== "fedramp-rev5" && catalogId !== "fedramp-20x") {
      setIngestError({
        code: "CATALOG_REQUIRED",
        message: "Choose FedRAMP Rev5 or FedRAMP 20x before upload.",
      });
      return;
    }
    const input = kind === "oscal" ? oscalRef.current : csvRef.current;
    const file = input?.files?.[0];
    if (!file) {
      setIngestError({
        code: "FILE_REQUIRED",
        message: kind === "oscal" ? "Choose an OSCAL JSON or XML file." : "Choose a CSV file.",
      });
      return;
    }
    const form = new FormData();
    form.set("catalog", catalogId);
    form.set("file", file);
    const body = await call(kind === "oscal" ? "/api/oscal/ingest" : "/api/ingest/csv", { method: "POST", body: form }, "ingest");
    showUploaded(body);
  }

  async function resetPackage() {
    const body = await call("/api/package/reset", { method: "POST" }, "none");
    if (!body.ok || body.packageState?.loaded) return;
    setLevel2(false);
    setItemId(null);
    setSelectedId(null);
    setView("map");
    if(sa1Demo)setPackageLoadOpen(true);
    setIngestError(null);
    setFlowError(null);
    setPanelError(null);
    setPanelProblems([]);
    setChanges(null);
    setStagedSample(null);
    setOscalFileReady(false);
    if (oscalRef.current) oscalRef.current.value = "";
    if (csvRef.current) csvRef.current.value = "";
  }

  async function loadGold() {
    const body = await call("/api/fixtures/load", { method: "POST", body: JSON.stringify({ fixture: "gold" }) }, "none");
    if (body.ok && body.packageState?.loaded) focusLoaded(body.packageState);
  }

  async function addEvidence() {
    if (!selected) return;
    const body = await call(
      `/api/controls/${selected.id}/evidence`,
      { method: "POST", body: JSON.stringify({ title, type, href }) },
      "panel",
    );
    if (body.ok) {
      setTitle("");
      setHref("");
      setType("Document");
      setEvidenceFormOpen(false);
      setFieldsOpen(true);
    } else if (implementation.trim() && role.trim()) {
      setFieldsOpen(false);
      setEvidenceFormOpen(true);
    }
  }

  async function saveControl() {
    if (!selected) return;
    const draft = title.trim() && href.trim() ? { title, type, href } : null;
    const body = await call(
      `/api/controls/${selected.id}/save`,
      { method: "POST", body: JSON.stringify({
        implementation,
        responsibleRole: role,
        responsibleRoles: [role, ...extraRoles].map((item) => item.trim()).filter(Boolean).join("|"),
        evidence: draft,
      }) },
      "panel",
    );
    if (body.ok) {
      const updated = body.packageState?.controls.find((control) => control.id === selected.id);
      if (updated) {
        setImplementation(updated.implementation);
        setRole(updated.responsibleRole);
        setExtraRoles(updated.roleLabels.slice(1));
      }
      if (draft) {
        setTitle("");
        setHref("");
        setType("Document");
      }
      setPartialSavedId(selected.id);
      setEvidenceFormOpen(false);
      setFieldsOpen(true);
    } else if (implementation.trim() && role.trim()) {
      setFieldsOpen(false);
    }
  }

  async function attachFile(file: File) {
    if (!selected) return;
    const form = new FormData();
    form.set("file", file);
    form.set("title", title.trim() || file.name);
    form.set("type", type || (file.type.startsWith("image/") ? "Screenshot" : "Document"));
    const body = await call(`/api/controls/${selected.id}/evidence/file`, { method: "POST", body: form }, "panel");
    if (body.ok) {
      setTitle("");
      setHref("");
      setType("Document");
      setEvidenceFormOpen(false);
      setFieldsOpen(true);
    }
  }

  async function retargetEvidence(evidenceId: string) {
    if (!selected) return;
    const item = selected.evidence.find((evidence) => evidence.id === evidenceId);
    if (!item) return;
    await call(
      `/api/controls/${selected.id}/evidence/${evidenceId}`,
      { method: "PATCH", body: JSON.stringify({ title: item.title, type: item.type, href: SEPTEMBER_HREF }) },
      "panel",
    );
  }

  async function openChanges() {
    setView("changes");
    const body = await call("/api/changes", undefined, "none");
    if (body.changes) setChanges(body.changes);
  }

  async function openFuture() {
    setView("future");
    const body = await call("/api/future", undefined, "none");
    if (body.stubs) setStubs(body.stubs);
    setStubsLoaded(true);
  }

  useEffect(() => {
    if (!synced || !viewRestored) return;
    const restored = restoredViewToLoad.current;
    restoredViewToLoad.current = null;
    if (restored !== view) return;
    if (restored === "changes") void openChanges();
    else if (restored === "future") void openFuture();
  }, [synced, viewRestored, view]);

  function openControl(id: string) {
    setLevel2(false);
    setItemId(null);
    setSelectedId(id);
    setView("map");
  }

  function enterFocus(id: string) {
    const statements = viewPkg.map.statements[id];
    if (!statements?.items.length) return;
    setSelectedId(id);
    setItemId(null);
    setLevel2(true);
    setView("map");
  }

  useEffect(() => {
    if (!(view === "release" && mapReturn) && !(view === "map" && level2 && !planningMap)) return;
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const target = event.target;
      if (target instanceof HTMLElement && target.closest("input, textarea, select, details, [role=dialog]")) return;
      event.preventDefault();
      if (view === "release") setView("map"); else setLevel2(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [level2, view, mapReturn, planningMap]);

  async function refreshChanges() {
    const body = await call("/api/changes", undefined, "none");
    if (body.changes) setChanges(body.changes);
  }

  const catalogId = pendingCatalog || pkg.catalog.id || "";
  const catalogChosen = catalogId === "fedramp-rev5" || catalogId === "fedramp-20x";
  const selectedChoice = pkg.catalogChoices.find((choice) => choice.id === catalogId) ?? null;
  const headerPkg = packageLoadOpen ? pkg : pkg.loaded ? pkg : planningMap ? shown : pkg;
  const pinShown = headerPkg.catalogPin ?? selectedChoice?.pin ?? null;
  // Presentation-only compatibility for previously loaded synthetic examples.
  const workspaceName = planningMap && !pkg.loaded
    ? shown.workspaceName
    : sa1Demo && ["SA1 · Synthetic service boundary", "Synthetic service boundary"].includes(pkg.workspaceName ?? "") ? "Internal planning boundary" : pkg.workspaceName;
  const workspaceLabel = synced ? (workspaceName ?? "None loaded") : "…";
  const evidenceWorkspaceLabel=connected.connection ? connectionSystemLabel(connected.connection) : pipelineSelected
    ? workspaceSystemLabel(pipelineSystemName(legacyChoice==="example"?CCM_EXAMPLE:receivedRelease),legacyChoice==="example"?"recorded example":"received pipeline")
    : pkg.loaded ? workspaceSystemLabel(workspaceName??"Unnamed system","uploaded package") : "No evidence selected";
  const sourceFilename = sa1Demo && pkg.sourceFilename === "sa1-synthetic-ssp.json" ? "internal-planning-ssp.json" : pkg.sourceFilename;
  const catalogLabel = synced ? headerPkg.catalog.label : "…";
  const catalogNote = !synced
    ? ""
    : headerPkg.catalog.status === "stub"
      ? "stub"
      : headerPkg.catalog.bound
        ? "live"
        : catalogChosen
          ? "selected"
          : "required";
  const pinLabel = synced ? (pinShown ?? "—") : "…";
  const sourceTitle = pkg.loaded && pkg.sourceFilename
    ? `Source ${sourceFilename}${pkg.sourceProfileHref ? ` · ${pkg.sourceProfileHref}` : ""} · ${pkg.catalog.label}`
    : undefined;
  const subsetBadge = headerPkg.loaded ? scopeChip(headerPkg.map.subsetMatch, headerPkg.inScopeCount, headerPkg.catalog.label) : null;
  const toolbarTitle = view === "export" ? "Export flow" : view === "changes" ? "Changes" : view === "future" ? "Future" : "Package map";

  function toggleDevChrome() {
    setDevChrome((current) => {
      const next = !current;
      try {
        window.localStorage.setItem(DEV_CHROME_KEY, next ? "1" : "0");
      } catch {
        // Keep the in-memory choice when storage is blocked.
      }
      return next;
    });
  }

  return (
    <PlanProposalProvider releases={synced ? storedMapReleases : []} planning={sa1Demo}>
    <div className={`app chrome-app${sa1Demo ? " sa1-app round21-app" : ""}`}>
      <header className="topbar chrome-topbar">
        <div className="mark" aria-hidden="true"><span /></div>
        <div className="brand">OSCAL binder</div>
        <div className={`chip ${synced && headerPkg.loaded ? "" : "dashed"}`} title={sourceTitle}>
          Workspace {sa1Demo ? <select className="workspace-system-select" title={evidenceWorkspaceLabel} aria-label="Evidence system" value={connected.selectedId ?? (pipelineSelected ? legacyChoice : "")} disabled={!synced} onChange={e => { if (e.target.value === "captured-reference") {setView("connections");return;} const legacy = e.target.value === "example" || e.target.value === "pipeline"; setSelectedId(null);setLevel2(false);setItemId(null);setPipelineArtifact(null);setMapFocusRequest(request=>request+1); if (legacy) setLegacyChoice(e.target.value); connected.select(legacy ? null : e.target.value || null); setPipelineSelected(legacy); if (e.target.value === "example") loadLegacyRelease(CCM_EXAMPLE); else if (e.target.value === "pipeline") loadLegacyRelease(receivedRelease); returnRelease.current = null; setView(legacy || !e.target.value ? "release" : "connections"); }}><option value="">{pkg.loaded?workspaceSystemLabel(workspaceName??"Unnamed system","uploaded package"):"No evidence selected"}</option><option value="example">{workspaceSystemLabel(pipelineSystemName(CCM_EXAMPLE),"recorded example")}</option><option value="captured-reference">Load captured evidence in System connections</option>{(legacyReleases.length > 0 || legacyRelease.source === "Inbound pipeline event") && <option value="pipeline">{workspaceSystemLabel(pipelineSystemName(receivedRelease),"received pipeline")}</option>}{connected.connections.map(c => <option key={c.id} value={c.id}>{connectionSystemLabel(c)}</option>)}</select> : <strong>{workspaceLabel}</strong>}
        </div>
        <div className={`chip chrome-catalog ${synced && headerPkg.catalog.bound ? "readonly" : "dashed"}`}>
          {sa1Demo && !planningMap ? "Package catalog" : "Catalog"} <strong>{catalogLabel}</strong>
          {catalogNote ? <span className="chip-note">{catalogNote}</span> : null}
        </div>
        <div className={`chip chrome-pin ${synced && headerPkg.loaded && headerPkg.catalogPin ? "readonly" : "dashed"}`}>
          <Term id="pin">Pin</Term>
          <strong className="chrome-pin-value" title={pinLabel}>{pinLabel}</strong>
          {synced && headerPkg.loaded && headerPkg.catalogPin ? <span className="chip-note">read only</span> : null}
        </div>
        {sa1Demo && <FixStopwatch key={connected.selectedId ?? "none"} progress={connected.connection?.fixProgress ?? null} />}
        <div className="spacer" />
        {synced && pkg.loaded ? (
          <button className="btn ghost new-package" type="button" onClick={() => void resetPackage()} disabled={busy}>
            New package
          </button>
        ) : null}
        {!synced ? (
          <div className="lamp empty" aria-busy="true" data-testid="gate-lamp">
            <span>Completeness</span>
            <strong>…</strong>
          </div>
        ) : headerPkg.gate.status === "EMPTY" ? (
          <div className="lamp empty" data-testid="gate-lamp">
            <Term id="gate">Completeness</Term>
            <strong>no package loaded</strong>
          </div>
        ) : (
          <div className={`lamp chrome-lamp ${planningMap && !pkg.loaded ? "coverage" : headerPkg.gate.status}`} data-testid="completeness-status">
            <span className="chrome-lamp-dot" aria-hidden="true" />
            {planningMap && !pkg.loaded ? <strong>Workspace coverage</strong> : sa1Demo ? <><strong>SSP fields</strong><Term id="gate">{headerPkg.gate.label}</Term></> : <><strong>Package completeness</strong><Term id="gate">{headerPkg.gate.status}</Term></>}
            {!(sa1Demo && pkg.loaded) && <span>{planningMap && !pkg.loaded ? headerPkg.gate.label.replace("recorded", "linked") : headerPkg.gate.label}</span>}
          </div>
        )}
      </header>
      <WorkspaceNavigation view={view} disabled={!synced} planning={sa1Demo} exportLocked={!pkg.loaded} onLoadExample={sa1Demo && !pkg.loaded ? () => void loadSa1() : undefined} onDeveloperDetails={toggleDevChrome} onNavigate={next => {
        if (next === "changes") void openChanges();
        else if (next === "future") void openFuture();
        else navigateView(next);
      }} />
      {view !== "release" && view !== "connections" && view !== "export" && !(sa1Demo && view === "map" && mapAvailable) && <div className={view === "map" && synced && mapAvailable ? `chrome-toolbar chrome-toolbar-map${level2 ? " chrome-toolbar-focus" : ""}${selected ? " chrome-toolbar-panel" : ""}` : "chrome-toolbar"}>
        <h1 className="chrome-title">{toolbarTitle}</h1>
        {subsetBadge ? <Term id="subset">{subsetBadge}</Term> : null}
        {!(view === "map" && level2) && (
          <p className="chrome-claim" data-testid="completeness-claim" title={COMPLETENESS_CLAIM}>
            {view === "map" && synced && headerPkg.loaded ? mapHonesty(headerPkg) : COMPLETENESS_CLAIM}
          </p>
        )}
      </div>}
      <main className={view === "map" && synced && mapAvailable ? "main chrome-main chrome-main-map" : "main chrome-main"}>
        {view === "connections" && <SystemConnections onRecordedEvidence={() => { setLegacyChoice("example"); connected.select(null); setPipelineSelected(true); loadLegacyRelease(CCM_EXAMPLE); setView("release"); }} store={connected} onArtifactLoad={beginArtifactArrival} onMap={() => { setConnectedReceipt(null); setMapHighlighted(true); setView("map"); }} onEvidence={(receiptIds) => { if (receiptIds) beginArtifactArrival(receiptIds); setConnectedReceipt(null); setView("release"); }} />}
        {sourceInventoryLoading && <p role="status" data-testid="source-inventory-loading">Loading captured source inventory…</p>}
        {sourceInventoryError && <p role="alert">{sourceInventoryError}</p>}
        {connected.sessionNotice && <p role="status" className="hint">{connected.sessionNotice} <button type="button" className="text-btn" onClick={()=>window.location.reload()}>Reload workspace</button></p>}
        {connected.error && view !== "connections" && <p role="status" className="hint">{connected.error} <button type="button" className="text-btn" onClick={()=>void connected.refresh()}>Retry connection</button></p>}
        {view === "release" && synced && mapReturn && <button type="button" className="btn ghost" data-testid="release-map-return" onClick={() => setView("map")}>← {selectedId && level2 ? `${selectedId} · Level 2` : "Package map"} <small>Esc</small></button>}
        {view === "release" && synced && sa1Demo && connected.connection && !observationReleases.length && <section className="release-card"><h1>{connected.connection.name}</h1><p>No observations received. Connect a collector in System connections.</p></section>}
        {view === "release" && synced && sa1Demo && !evidenceSelected && <section className="release-card"><h1>No evidence selected</h1><p>Connect a system, import collector observations, or explicitly choose a recorded example.</p><button className="btn primary" type="button" onClick={() => setView("connections")}>Open system connections</button></section>}
        {view === "release" && synced && sa1Demo && evidenceSelected && !sourceInventoryLoading && !sourceInventoryError && !(connected.connection && !observationReleases.length) && <>
          <PipelineEvidenceView arrival={arrival} onCollect={() => setView("connections")} onOpenMap={() => {setMapAllFamilies(true);navigateView("map");}} coverageNavigation={coverageNavigation} onCoverageNavigation={setCoverageNavigation} record={mappedRelease} proposalRecord={release} receivedReleases={mappedReceivedReleases} proposalReleases={receivedReleases} mappingDecisions={activeMappingDecisions} mappingControlIds={mappingControlIds} mappingCatalogId={mappingCatalogId} mappingStorageNote={mappingStorageNote} onMappingDecision={decideArtifactMapping} relationships={viewPkg.map.edges} connection={connected.connection ? undefined : pipelineConnection} onRecordChange={(next) => { updateRelease(rawRelease(next)); setPipelineArtifact(null); }} onImportRecord={(next) => { setLegacyChoice("pipeline"); beginArtifactArrival([next.releaseSha256]); updateRelease(next); setPipelineArtifact(null); }} packageControls={viewPkg.controls.map((control) => control.id)} controlTitles={Object.fromEntries(viewPkg.controls.map((control) => [control.id, control.title]))} onOpenControl={(id, focus, artifact, source) => {
            returnRelease.current = release;
            if (source) updateRelease(rawRelease(source));
            setMapHighlighted(true); setView("map"); setSelectedId(artifact && !focus ? null : id); setLevel2(focus); setItemId(null); setPipelineArtifact(artifact ? artifactFilename(artifact) : null);
          }} />
        </>}
        {view === "map" && !synced && (
          <section className="empty-canvas" aria-busy="true">
            <p className="hint">Reading this browser&apos;s package…</p>
          </section>
        )}
        {view === "map" && synced && (!mapAvailable || packageLoadOpen) && sa1Demo && <section className="empty-canvas planning-empty" data-testid="planning-empty">
          <div className="ingest-card"><p className="kicker">Empty workspace</p><h2>{packageLoadOpen ? "Load an OSCAL package" : "No system connected"}</h2><p>{packageLoadOpen ? "Choose a package catalog and upload its SSP. Evidence connections and accepted plans remain available." : "Connect a system or load captured evidence to start. Nothing loads until you choose it."}</p>{packageLoadOpen && <button className="text-btn" type="button" onClick={()=>setPackageLoadOpen(false)}>← Return to Package map</button>}
            <div className="empty-connect"><button className="btn primary" type="button" onClick={() => setView("connections")}>Connect a system or load captured evidence →</button><small>Opens System connections · no package catalog needed</small></div>
            <fieldset className="catalog-choices"><legend>Package catalog <small>Needed to upload, map and export a package</small></legend>{pkg.catalogChoices.map(choice => <label key={choice.id} className={catalogId === choice.id ? "catalog-choice on" : "catalog-choice"}><input type="radio" name="catalog-baseline" value={choice.id} checked={catalogId === choice.id} onChange={() => void chooseCatalog(choice.id)} disabled={ingestBusy} /><span><strong>{choice.label} <em data-status={choice.status}>{choice.status === "stub" ? "stub" : "live"}</em></strong><code>{choice.pin}</code><small>{choice.status === "stub" ? "Separate stub subset" : "Sample package subset · 12 controls"}</small></span></label>)}</fieldset>
            <p className="hint">Evidence coverage counts against the full Rev5 Moderate baseline, 323 entries · <code>fedramp-3.0.0rc1-oscal-1.1.2</code></p>
            {selectedChoice?.status === "stub" && <p className="banner warn" role="status">{selectedChoice.note}</p>}
            <div className="empty-upload"><label className="file-field"><span>Upload an existing OSCAL package{!catalogChosen && <small> · Choose a package catalog first</small>}</span><input ref={oscalRef} onChange={onOscalFileChange} type="file" accept=".json,.xml,application/json,text/xml,application/xml" disabled={!catalogChosen || ingestBusy} /></label><button className="btn ghost" type="button" onClick={() => void uploadPackage("oscal")} disabled={!catalogChosen || ingestBusy || !oscalFileReady}>Upload OSCAL</button></div><p className="hint">JSON or XML · root <code>system-security-plan</code>. Component definitions are rejected.</p>
            {stagingSample && <p className="hint" role="status">Preparing sample… Upload is available when the file is staged.</p>}
            {stagedSample && <p className="hint" role="status">Sample staged: <code>{stagedSample}</code>. Click Upload OSCAL.</p>}
            {ingestError && <div className="banner fail" role="alert"><p className="error-code">{ingestError.code}</p><p>{ingestError.message}</p><button className="btn ghost" type="button" onClick={() => setIngestError(null)}>Clear error</button></div>}
            <details className="empty-starting-points"><summary>More starting points <small>Examples load only when chosen</small></summary>
              <button className="empty-start" type="button" onClick={() => { setLegacyChoice("example"); setPipelineSelected(true); setMapHighlighted(true); loadLegacyRelease(CCM_EXAMPLE); setView("release"); }}><strong>Load {releaseSystemName([CCM_EXAMPLE])} evidence example</strong><small>Recorded release · pipeline evidence</small><span>→</span></button>
              <button className="empty-start" type="button" disabled={ingestBusy} onClick={() => void loadSa1()}><strong>Load planning example</strong><small>Demo sample package with statement mappings</small><span>→</span></button>
              <button className="empty-start" type="button" disabled={ingestBusy} onClick={() => void useSample()}><strong>Stage sample SSP</strong><small>Upload stays a separate click · not authorization evidence</small><span>→</span></button>
              {devChrome && <div className="sample-links"><a href="/samples/sample-oscal-ssp-rev5.json" download="sample-oscal-ssp-rev5.json">↓ Rev5 subset sample</a><a href="/samples/sample-oscal-ssp-20x.json" download="sample-oscal-ssp-20x.json">↓ 20x stub sample</a></div>}<p className="hint">Demo sample package and CSV control table are developer paths · <button className="text-btn" type="button" onClick={toggleDevChrome}>Developer details</button></p>
            </details>
            {devChrome && <div className="csv-secondary"><button className="btn ghost" type="button" onClick={() => void loadGold()} disabled={!catalogChosen || ingestBusy}>Load demo sample package</button><p className="hint">Canned boundary bnd-gold-0001. Rev5 subset demo only.</p><label className="file-field">CSV control table<input ref={csvRef} type="file" accept=".csv,text/csv" disabled={!catalogChosen || ingestBusy} /></label><button className="btn ghost" type="button" onClick={() => void uploadPackage("csv")} disabled={!catalogChosen || ingestBusy}>Upload CSV</button></div>}
          </div>
        </section>}
        {view === "map" && synced && !mapAvailable && !sa1Demo && (
          <section className="empty-canvas">
            <div className="ingest-card">
              <p className="kicker">Empty workspace</p>
              <h2>{sa1Demo ? "No system connected" : "No package loaded"}</h2>
              <p>{sa1Demo ? "Connect a system or import collector evidence to begin. Captured evidence and recorded examples load only when you choose them. You can also upload an existing OSCAL package below." : "Choose a catalog baseline. Upload OSCAL is the package path. Load demo sample package is the offline demo."}</p>
              {sa1Demo && <div className="ingest-actions"><button className="btn primary" type="button" onClick={() => setView("connections")}>Connect a system or load captured evidence</button><button className="btn ghost" type="button" onClick={() => { setLegacyChoice("example"); setPipelineSelected(true); setMapHighlighted(true); loadLegacyRelease(CCM_EXAMPLE); setView("release"); }}>Load {releaseSystemName([CCM_EXAMPLE])} evidence example</button></div>}
              <fieldset className="catalog-choices">
                <legend>Catalog baseline</legend>
                {pkg.catalogChoices.map((choice) => (
                  <label key={choice.id} className={catalogId === choice.id ? "catalog-choice on" : "catalog-choice"}>
                    <input
                      type="radio"
                      name="catalog-baseline"
                      value={choice.id}
                      checked={catalogId === choice.id}
                      onChange={() => void chooseCatalog(choice.id)}
                      disabled={ingestBusy}
                    />
                    <span>
                      <strong>{choice.label}</strong>
                      <code>{choice.pin}</code>
                      <em>{choice.status === "stub" ? "stub" : "live"}</em>
                    </span>
                  </label>
                ))}
              </fieldset>
              {selectedChoice?.status === "stub" && (
                <p className="banner warn" role="status">{selectedChoice.note}</p>
              )}
              <p className="pin-line">
                <Term id="pin">Pin</Term> <code>{pinShown ?? "—"}</code>
              </p>
              <label className="file-field">
                OSCAL package
                <input ref={oscalRef} onChange={onOscalFileChange} type="file" accept=".json,.xml,application/json,text/xml,application/xml" disabled={!catalogChosen || ingestBusy} />
              </label>
              <div className="ingest-actions">
                <button className="btn ghost" type="button" onClick={() => void useSample()} disabled={ingestBusy}>
                  Stage sample SSP
                </button>
                <button className="btn primary" type="button" onClick={() => void uploadPackage("oscal")} disabled={!catalogChosen || ingestBusy || !oscalFileReady}>
                  Upload OSCAL
                </button>
                <button className="btn ghost" type="button" onClick={() => void loadGold()} disabled={!catalogChosen || ingestBusy}>
                  Load demo sample package
                </button>
              </div>
              {stagingSample && <p className="hint" role="status">Preparing sample… Upload is available when the file is staged.</p>}
              {stagedSample && (
                <p className="hint" role="status">
                  Sample staged: <code>{stagedSample}</code>. Click Upload OSCAL.
                </p>
              )}
              <p className="hint">
                Upload a JSON or XML file whose root is <code>system-security-plan</code>. A component-definition file is rejected.
              </p>
              <p className="sample-links">
                <a href="/samples/sample-oscal-ssp-rev5.json" download="sample-oscal-ssp-rev5.json">FedRAMP Rev5 subset sample</a>
                <a href="/samples/sample-oscal-ssp-20x.json" download="sample-oscal-ssp-20x.json">FedRAMP 20x stub sample</a>
              </p>
              <p className="hint">
                Rev5 sample is the 12-control FedRAMP Rev5 subset. Not the full FedRAMP Rev5 baseline and not authorization evidence. Match the sample to the catalog you select.
              </p>
              <p className="hint">Load demo sample package opens canned boundary bnd-gold-0001. Demo bootstrap only. It uses the Rev5 subset pin.</p>
              {ingestError && (
                <div className="banner fail" role="alert">
                  <p className="error-code">{ingestError.code}</p>
                  <p>{ingestError.message}</p>
                  <button className="btn ghost" type="button" onClick={() => setIngestError(null)}>
                    Clear error
                  </button>
                </div>
              )}
              <div className="csv-secondary">
                <p className="hint">
                  CSV control table is a best-effort path. It is not the OSCAL package ingest.{" "}
                  <a href="/samples/sample-controls.csv" download="sample-controls.csv">CSV sample</a>
                </p>
                <label className="file-field">
                  CSV control table
                  <input ref={csvRef} type="file" accept=".csv,text/csv" disabled={!catalogChosen || ingestBusy} />
                </label>
                <div className="ingest-actions">
                  <button className="btn ghost" type="button" onClick={() => void uploadPackage("csv")} disabled={!catalogChosen || ingestBusy}>
                    Upload CSV
                  </button>
                </div>
              </div>
            </div>
          </section>
        )}

        {view === "map" && synced && planningMap && !packageLoadOpen && <RollupMap exampleMetadata={connected.connection ? capturedMapExample(connected.connection) : pipelineSelected && legacyChoice==="example"} pkg={viewPkg} mapStructure={mapStructure} focusRequest={mapFocusRequest} pipelineArtifact={pipelineArtifact} onSelectPipelineArtifact={setPipelineArtifact} basePkg={pkg} proposalCounts={mapProposalCounts} snapshotProposalCounts={snapshotProposalCounts} history={storedMapReleases} record={mappedRelease} onRecordChange={(next) => updateRelease(rawRelease(next))} packageControlIds={pkg.controls.map(control => control.id)} initialControlId={selectedId} initialLevel2={level2} initialItemId={itemId} workspaceNotice={evidenceSelected && !pkg.loaded && !connected.connection ? <div className="release-load recorded-example-note"><span>{recordedIntroSeen ? "Recorded example · package optional" : "Recorded evidence example. Load the demo sample package to inspect its statements and roles."}</span></div> : undefined} storageKey={`binder.map-focus.v1:${viewStorageKey}`} focusRef={mapFocus} highlighted={evidenceSelected && mapHighlighted} onHighlightChange={setMapHighlighted} allFamilies={mapAllFamilies} onAllFamiliesChange={setMapAllFamilies} onRelease={() => navigateView("release")} />}
        {view === "map" && synced && pkg.loaded && !planningMap && (
          <div className={selected ? "workspace" : "workspace map-only"}>
            <div className="map-col chrome-map-col">
              {pkg.catalog.status === "stub" && <p className="banner warn chrome-stub" role="status">{pkg.catalog.note}</p>}
              <PackageMap
                pkg={viewPkg}
                pipelineEvidence={sa1Demo && evidenceSelected ? mappedRelease : undefined}
                pipelineArtifact={pipelineArtifact}
                onSelectPipelineArtifact={setPipelineArtifact}
                selectedId={selectedId}
                level2={level2}
                selectedItemId={itemId}
                onSelect={openControl}
                onEnterFocus={enterFocus}
                onLeaveFocus={() => setLevel2(false)}
                onSelectItem={setItemId}
                onClearSelection={() => {
                  setLevel2(false);
                  setItemId(null);
                  setSelectedId(null);
                }}
                onOpenControlFocus={(controlId, nextItem) => {
                  setSelectedId(controlId);
                  setItemId(nextItem);
                  setLevel2(true);
                  setView("map");
                }}
              />
            </div>
            {selected ? (
              <ControlPanel
                sa1Demo={sa1Demo}
                onPrepareSa1={prepareSa1Evidence}
                pkg={shown}
                control={selected}
                busy={busy || Boolean(selected.rollupState)}
                error={panelError}
                problems={panelProblems}
                implementation={implementation}
                role={role}
                title={title}
                type={type}
                href={href}
                fieldsOpen={fieldsOpen}
                evidenceFormOpen={evidenceFormOpen}
                onImplementation={(value) => {
                  setPartialSavedId(null);
                  setImplementation(value);
                  clearStalePanel();
                }}
                onRole={(value) => {
                  setPartialSavedId(null);
                  setRole(value);
                  clearStalePanel();
                }}
                onTitle={(value) => {
                  setPartialSavedId(null);
                  setTitle(value);
                  clearStalePanel();
                }}
                onType={(value) => {
                  setType(value);
                  clearStalePanel();
                }}
                onHref={(value) => {
                  setPartialSavedId(null);
                  setHref(value);
                  clearStalePanel();
                }}
                onEditFields={() => setFieldsOpen(true)}
                onOpenEvidenceForm={() => setEvidenceFormOpen(true)}
                onAdd={() => void addEvidence()}
                onSave={() => void saveControl()}
                onAttachFile={(file) => void attachFile(file)}
                onFillAc2={() => {
                  setImplementation(AC2_IMPLEMENTATION);
                  setRole("CSP IAM Administrator");
                  setTitle("Quarterly account review");
                  setType("Document");
                  setHref("evidence/ac-2/iam-review-2026-08.pdf");
                  setPanelError(null);
                  setPanelProblems([]);
                }}
                onFillAu2={() => {
                  setTitle("SIEM logging standard");
                  setType("Document");
                  setHref("evidence/au-2/event-logging-standard-2026-08.pdf");
                  setPanelError(null);
                  setPanelProblems([]);
                }}
                onFillCm6={() => {
                  setImplementation(CM6_IMPLEMENTATION);
                  setPanelError(null);
                  setPanelProblems([]);
                }}
                onRetarget={(evidenceId) => void retargetEvidence(evidenceId)}
                onClose={() => {
                  setLevel2(false);
                  setItemId(null);
                  setSelectedId(null);
                  setPanelError(null);
                  setPanelProblems([]);
                }}
                level2={level2}
                selectedItemId={itemId}
                extraRoles={extraRoles}
                onExtraRoles={(roles) => {
                  setPartialSavedId(null);
                  setExtraRoles(roles);
                  clearStalePanel();
                }}
                devChrome={devChrome}
                savedPartial={partialSavedId === selected.id}
                onExpand={() => {
                  if (selected) enterFocus(selected.id);
                }}
                onSelectItem={setItemId}
              />
            ) : null}
          </div>
        )}
        {view === "export" && (
          <ExportFlow
            sa1Demo={sa1Demo}
            pkg={pkg}
            busy={busy}
            error={flowError}
            onCall={(url, init) => call(url, init, "flow")}
            onOpenControl={openControl}
            onLoadSample={sa1Demo ? () => void loadSa1(true) : undefined}
            onOpenPackage={() => {setPackageLoadOpen(true);navigateView("map");}}
          />
        )}
        {view === "changes" && (
          <ChangesPanel
            pkg={pkg}
            changes={changes}
            busy={busy}
            error={flowError}
            baselineEnabled={pkg.pipeline.baseline.enabled}
            onOpenControl={openControl}
            onReexport={() => {
              void (async () => {
                const exported = await call("/api/oscal/export", { method: "POST" }, "flow");
                if (exported.ok && exported.filename && typeof exported.xml === "string") {
                  downloadXmlFile(exported.filename, exported.xml);
                } else if (exported.ok && exported.filename) {
                  try {
                    await downloadOscalArtifact(exported.filename, sa1Demo);
                  } catch (error) {
                    setFlowError(error instanceof Error ? error.message : "Could not download the OSCAL file.");
                  }
                }
                if (exported.ok && exported.packageState?.gate.status === "PASS") {
                  await call("/api/oscal/validate", {
                    method: "POST",
                    body: JSON.stringify({ scenario: "current" }),
                  }, "flow");
                }
                await refreshChanges();
              })();
            }}
            onBaseline={() => {
              void (async () => {
                await call("/api/baseline", { method: "POST" }, "flow");
                await refreshChanges();
              })();
            }}
          />
        )}
        {view === "future" && (
          <FuturePanel
            note={pkg.future.note}
            liveConnections={pkg.future.liveConnections}
            stubs={stubs}
            loaded={stubsLoaded}
          />
        )}
      </main>
      <footer className="footer chrome-footer">
        <span>OSCAL binder alpha</span>
        <span className="d6">{pkg.disclaimer.id}</span><span className="chrome-disclaimer">{sa1Demo ? "Internal planning · Evidence links are coverage · Not FedRAMP authorized or an ATO result" : pkg.disclaimer.text}</span>
        {devChrome ? (
          <span className="chrome-dev" data-testid="dev-cli">
            {pkg.loaded && sourceFilename ? <span>Source {sourceFilename}</span> : null}
            {pkg.map.available ? <span>{pkg.map.edges.length} edges</span> : null}
            <span>{pkg.cli.note.replace(/ · read only$/, "")}</span>
            <code>$ {pkg.cli.validate}</code>
            <code>$ {pkg.cli.export}</code>
          </span>
        ) : null}
        <span className="spacer" />
        <a className="chrome-account" href="/account">Account</a>
        <span className="chrome-build" data-testid="build-version">build {buildCommit}</span>

      </footer>
    </div>
    </PlanProposalProvider>
  );
}
