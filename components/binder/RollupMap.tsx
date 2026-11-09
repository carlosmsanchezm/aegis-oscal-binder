"use client";
import {mapMetadata,type MapMetadataSources} from "@/lib/aegis/map-metadata";
import {MapMetadataPanel} from "./MapMetadataPanel";
import {providerExtent} from "@/lib/aegis/provider-coverage";
import { evidenceViewerHref } from "@/lib/builder/evidence-links";
import {SourceRepo,SystemSources} from "./SourceRepo";
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { observationControl } from "@/lib/aegis/connected-evidence";
import { countLabel, utcTime, receiptLabel } from "@/lib/builder/presentation";
import { freshnessLabel } from "@/lib/builder/evidence";
import { directedLinksFor, familyRelationships } from "@/lib/aegis/map-view";
import {
  releaseProject,
  rollupControlResults, releasesAtSnapshot,
  resultForReviewItem,
  type ProvenResult,
} from "@/lib/aegis/control-rollup";
import type { PipelineEvidence } from "@/lib/aegis/pipeline-evidence";
import type { ControlView, PackageState } from "@/lib/aegis/types";
import { releaseSystemName } from "@/lib/aegis/rollup-package";
import { PackageMap,RoleCardBody,EvidenceCardBody,type MapNodeSelection } from "./PackageMap";
import { resultsMapPackage } from "@/lib/aegis/results-map";
import {rankEffortNext} from "@/lib/aegis/effort-ranking";
import {controlPlanLabel,proposePlans} from "@/lib/aegis/plan-proposal";
import { PlanProposalDrawer, ProposedPlanSummary, usePlanProposals, useResolvedProposal } from "./PlanProposal";
import { NextWorkBand } from "./NextWorkBand";
import {planNeedsDecision} from "@/lib/collector/control-evidence";
import { CONTROL_PANEL } from "@/lib/aegis/ui-copy";
import { Round21Focus } from "./Round21Focus";
import { ObservedEvidenceFocus } from "./ObservedEvidenceFocus";
import { EvidenceFocus } from "./EvidenceFocus";

function systemLabel(url: string, history: PipelineEvidence[] = []) {
  const name = releaseSystemName([
    history.find(r=>r.pipelineUrl === url) ?? { pipelineUrl: url, createdAt: "", pipelineId: "" } as PipelineEvidence,
  ]);
  return name.charAt(0).toUpperCase() + name.slice(1);
}

export function ReleaseSnapshot({
  history,
  record,
  highlighted,
  onChange,
}: {
  history: PipelineEvidence[];
  record: PipelineEvidence;
  highlighted: boolean;
  onChange: (release: PipelineEvidence | null) => void;
}) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    function close(event: PointerEvent) {
      if (ref.current && !ref.current.contains(event.target as Node))
        ref.current.open = false;
    }
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);
  function choose(release: PipelineEvidence | null) {
    onChange(release);
    if (ref.current) {
      ref.current.open = false;
      ref.current.querySelector("summary")?.focus();
    }
  }
  return (
    <details
      ref={ref}
      className={`round21-snapshot${highlighted ? " active" : ""}`}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !e.defaultPrevented && ref.current) {
          ref.current.open = false;
          e.stopPropagation();
        }
      }}
    >
      <summary
        title={highlighted ? `${record.schema === "aegis.evidence-event.v1" ? record.observation.systemName : systemLabel(record.pipelineUrl)} · #${record.pipelineId}` : "No release snapshot selected"}
        aria-label={`Release snapshot ${highlighted ? "#" + record.pipelineId : "None"}`}
      >
        <span>Release snapshot</span>
        <b>
          {highlighted ? (
            <>
              <span title={record.schema === "aegis.evidence-event.v1" ? record.observation.systemName : systemLabel(record.pipelineUrl)}>
                {record.schema === "aegis.evidence-event.v1" ? record.observation.systemName : systemLabel(record.pipelineUrl)}
              </span>
              <code title={record.pipelineId}>#{receiptLabel(record.pipelineId)}</code>
            </>
          ) : "None"}
        </b>
        <i>▾</i>
      </summary>
      <div
        className="round21-snapshot-menu"
        role="listbox"
        aria-label="Map release selection"
      >
        <button
          type="button"
          role="option"
          aria-selected={!highlighted}
          onClick={() => choose(null)}
        >
          <i>{!highlighted ? "✓" : ""}</i>
          <span>
            <b>None</b>
            <small>current map · no release highlight</small>
          </span>
        </button>
        {history.map((release) => (
          <button
            type="button"
            role="option"
            aria-selected={
              highlighted && release.pipelineId === record.pipelineId
            }
            key={release.pipelineId + release.commitSha}
            onClick={() => choose(release)}
          >
            <i>
              {highlighted && release.pipelineId === record.pipelineId
                ? "✓"
                : "■"}
            </i>
            <span>
              <b>
                {release.schema === "aegis.evidence-event.v1" ? release.observation.systemName : systemLabel(release.pipelineUrl)}{" "}
                <code>#{release.pipelineId}</code>
              </b>
              <small>Latest result per control across stored releases</small>
            </span>
          </button>
        ))}
        <p>
          A newer release replaces the older result for each control it covers,
          only that control.
        </p>
      </div>
    </details>
  );
}

export type RollupMapFocus = { controlId: string | null; level2: boolean; itemId: string | null };
type StoredMapFocus=RollupMapFocus & {familyId:string|null;mode:"family"|"selected";relatedEnabled:boolean};

export function RollupMap({
  pkg,
  exampleMetadata = false,
  basePkg,
  mapStructure,
  focusRequest = 0,
  pipelineArtifact,
  onSelectPipelineArtifact,
  proposalCounts,
  snapshotProposalCounts,
  history,
  record,
  onRecordChange,
  packageControlIds,
  initialControlId = null,
  initialLevel2 = false,
  initialItemId = null,
  focusRef,
  storageKey,
  highlighted: initialHighlighted = true, workspaceNotice,
  onHighlightChange,
  allFamilies: initialAll = false,
  onAllFamiliesChange,
  onRelease,
}: {
  pkg: PackageState;
  exampleMetadata?:boolean;
  basePkg?: PackageState;
  mapStructure?: PackageState;
  focusRequest?: number;
  pipelineArtifact?: string | null;
  onSelectPipelineArtifact?: (artifact: string | null) => void;
  proposalCounts?: ReadonlyMap<string, number>;
  snapshotProposalCounts?:ReadonlyMap<string,number>;
  history: PipelineEvidence[];
  record: PipelineEvidence;
  onRecordChange: (record: PipelineEvidence) => void;
  packageControlIds: string[];
  initialControlId?: string | null;
  initialLevel2?: boolean;
  initialItemId?: string | null;
  focusRef?: React.RefObject<RollupMapFocus | null>;
  storageKey?:string;
  highlighted?: boolean;
  workspaceNotice?:React.ReactNode;
  onHighlightChange?: (value: boolean) => void;
  allFamilies?: boolean;
  onAllFamiliesChange?: (value: boolean) => void;
  onRelease?: () => void;
}) {
  const [saved]=useState(()=>{
    if(!storageKey || typeof window === "undefined")return null;
    try {const value=JSON.parse(sessionStorage.getItem(storageKey)??"null");
      return value && (value.controlId===null || pkg.controls.some(c=>c.id===value.controlId)) ? value : null;
    }catch{return null;}
  });
  const [familyId,setFamilyId]=useState<string|null>(saved?.familyId??null);
  const [selectedId, setSelectedId] = useState<string|null>(initialControlId??saved?.controlId??null);
  const [level2, setLevel2] = useState(initialControlId ? initialLevel2 : saved?.level2===true);
  const [itemId, setItemId] = useState<string | null>(initialItemId??saved?.itemId??null);
  const [viewMode,setViewMode]=useState<"family"|"selected">(saved?.mode==="family" ? "family" : (initialControlId || saved?.controlId) ? "selected" : "family");
  const [relatedEnabled,setRelatedEnabled]=useState(saved?.relatedEnabled!==false);
  const focusState=useRef<StoredMapFocus>({controlId:selectedId,level2,itemId,familyId,mode:viewMode,relatedEnabled});
  function persistFocus(patch:Partial<StoredMapFocus>){
    const next={...focusState.current,...patch};focusState.current=next;
    if(storageKey)try{sessionStorage.setItem(storageKey,JSON.stringify(next));}catch{/* In-memory focus still works without storage. */}
  }
  // Commit user choices in the action, before a reload can interrupt a passive effect.
  // Layout synchronization also covers focus changes made by the shell.
  useLayoutEffect(()=>{persistFocus({controlId:selectedId,level2,itemId,familyId,mode:viewMode,relatedEnabled});},[storageKey,selectedId,level2,itemId,familyId,viewMode,relatedEnabled]);
  function changeMode(mode:"family"|"selected"){persistFocus({mode});setViewMode(mode);}
  function changeRelated(value:boolean){persistFocus({relatedEnabled:value});setRelatedEnabled(value);}
  function changeLevel2(value:boolean){persistFocus({level2:value});setLevel2(value);}
  function changeItem(value:string|null){persistFocus({itemId:value});setItemId(value);}
  function changeFamily(value:string|null){setInspectedNode(null);persistFocus({familyId:value});setFamilyId(value);}
  const [inspectedNode,setInspectedNode]=useState<MapNodeSelection|null>(null);
  const [roleFocus,setRoleFocus]=useState<MapNodeSelection|null>(null);
  const [evidenceId, setEvidenceId] = useState<string | null>(null);
  const [allFamilies, setAllFamilies] = useState(initialAll);
  const [localHighlighted, setLocalHighlighted] = useState(initialHighlighted);
  const highlighted = onHighlightChange ? initialHighlighted : localHighlighted;
  useEffect(() => {
    setAllFamilies(initialAll);
  }, [initialAll]);
  // Focus stays with the shared map instance during workspace changes.
  // Publish committed focus; the shell captures it before navigating away.
  useLayoutEffect(() => {
    if (!focusRef) return;
    focusRef.current = { controlId: selectedId, level2, itemId };
    return () => { focusRef.current = null; };
  }, [selectedId, level2, itemId, focusRef]);
  const snapshotHistory=useMemo(()=>releasesAtSnapshot(history,record),[history,record]);
  const results = useMemo(
    () =>
      new Map(rollupControlResults(snapshotHistory).map((row) => [row.id, row.result])),
    [snapshotHistory],
  );
  const planContext = usePlanProposals();
  const [nextPlanId, setNextPlanId] = useState<string | null>(null);
  const focusStorageKey = `binder.next-focus.v1:${releaseProject(record.pipelineUrl)}`;
  const [nextFocus, setNextFocus] = useState<{ focused: string | null; dismissed: string[] }>({ focused: null, dismissed: [] });
  useEffect(() => {
    try {
      const value = JSON.parse(window.sessionStorage.getItem(focusStorageKey) ?? "null") as { focused?: string | null; dismissed?: string[] } | null;
      if (!value) { setNextFocus({ focused: null, dismissed: [] }); return; }
      setNextFocus({ focused: value.focused ?? null, dismissed: Array.isArray(value.dismissed) ? value.dismissed.filter((id): id is string => typeof id === "string") : [] });
    } catch { setNextFocus({ focused: null, dismissed: [] }); }
  }, [focusStorageKey]);
  const planStateLabels = useMemo(() => new Map([...results.keys()].flatMap(id => {
    const label = controlPlanLabel(planContext?.proposals.filter(proposal => proposal.controlId === id) ?? []);
    return label ? [[id, label] as const] : [];
  })), [results, planContext?.proposals]);
  const reviewControlIds=useMemo(()=>new Set([...results].filter(([id,result])=>{
    const plans = planContext?.proposals.filter(proposal => proposal.controlId === id) ?? [];
    return result?.finding && (!plans.length || plans.some(proposal => !proposal.closureConfirmed));
  }).map(([id])=>id)),[results, planContext?.proposals]);
  const recordedControlIds=useMemo(()=>new Set((mapStructure??pkg).controls.filter(control=>control.rollupState==="recorded").map(control=>control.id)),[mapStructure,pkg]);
  const subset = basePkg?.loaded ? basePkg : null;
  const metadata=useMemo(()=>mapMetadata(pkg,subset,exampleMetadata),[pkg,subset,exampleMetadata]);
  const [owner,setOwner]=useState("");
  useEffect(()=>{if(owner&&!metadata.pkg.roles.some(role=>role.id===owner))setOwner("");},[metadata,owner]);
  const mapPkg = useMemo(() => {
    const structure = resultsMapPackage(mapStructure??pkg, subset, highlighted, allFamilies, proposalCounts);
    const overlay = new Map(metadata.pkg.controls.map(control => [control.id, control]));
    return {...structure, roles:metadata.pkg.roles, controls: structure.controls.map(control => ({...control,
      providerCoverage: overlay.get(control.id)?.providerCoverage??control.providerCoverage,
      implementedBy: overlay.get(control.id)?.implementedBy??control.implementedBy,
      responsibleRoleId:overlay.get(control.id)?.responsibleRoleId??control.responsibleRoleId,
      responsibleRoleIds:overlay.get(control.id)?.responsibleRoleIds??control.responsibleRoleIds,
      responsibleRole:overlay.get(control.id)?.responsibleRole??control.responsibleRole,
      roleLabels:overlay.get(control.id)?.roleLabels??control.roleLabels,
      rollupState: highlighted ? overlay.get(control.id)?.rollupState : undefined,
      rollupReleaseId: highlighted ? overlay.get(control.id)?.rollupReleaseId : undefined,
    }))};
  }, [metadata,mapStructure,pkg,subset,highlighted,allFamilies,proposalCounts]);
  const lastFocusRequest = useRef(focusRequest);
  useLayoutEffect(() => {
    if (lastFocusRequest.current === focusRequest) return;
    lastFocusRequest.current = focusRequest;
    setSelectedId(initialControlId);setLevel2(initialLevel2);setItemId(initialItemId);
    setFamilyId(null);setViewMode(initialControlId ? "selected" : "family");
  }, [focusRequest, initialControlId, initialLevel2, initialItemId]);
  useEffect(() => {
    if (pkg.controls.length && selectedId && !pkg.controls.some(control => control.id === selectedId)) close();
  }, [pkg.controls, selectedId]);
  const controlsById=useMemo(()=>new Map(pkg.controls.map(control=>[control.id,control])),[pkg.controls]);
  const selected = selectedId ? controlsById.get(selectedId) : undefined;
  const original =
    subset?.controls.find((c) => c.id === selectedId) ?? selected;
  const focusPkg = useMemo(()=>subset
    ? {
        ...subset,
        controls: subset.controls.map((c) => ({
          ...c,
          rollupReleaseId: controlsById.get(c.id)?.rollupReleaseId,
        })),
        map: {
          ...subset.map,
          edges: pkg.map.edges,
          statements: { ...pkg.map.statements, ...subset.map.statements },
          byControl: { ...pkg.map.byControl, ...subset.map.byControl },
        },
      }
    : pkg,[subset,pkg,controlsById]);
  function close() {
    setInspectedNode(null);setRoleFocus(null);
    persistFocus({mode:"family",familyId:null,controlId:null,level2:false,itemId:null});
    setViewMode("family");setFamilyId(null);setSelectedId(null);
    setLevel2(false);
    setItemId(null);
    setEvidenceId(null);
  }
  function showAll(value: boolean) {
    setAllFamilies(value);
    onAllFamiliesChange?.(value);
  }
  function select(id: string) {
    setInspectedNode(null);setRoleFocus(null);
    persistFocus({mode:"selected",familyId:null,controlId:id,itemId:null});
    setViewMode("selected");setFamilyId(null);setSelectedId(id);
    setItemId(null);
    setEvidenceId(null);
  }
  const inspectNode=useCallback((node:MapNodeSelection|null)=>{
    setInspectedNode(node);
    if(node){setSelectedId(null);setFamilyId(null);setItemId(null);setViewMode("family");}
  },[]);
  useEffect(() => {
    function key(e: KeyboardEvent) {
      if (
        e.key === "Escape" && !e.defaultPrevented &&
        !(
          e.target instanceof HTMLElement &&
          e.target.closest("input,textarea,select,details,[role=dialog]")
        )
      ) {
        if(roleFocus)setRoleFocus(null);
        else if (evidenceId) setEvidenceId(null);
        else if(inspectedNode)setInspectedNode(null);
        else if (level2) changeLevel2(false);
        else {persistFocus({familyId:null,controlId:null});setFamilyId(null);setSelectedId(null);}
      }
    }
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [level2, evidenceId,roleFocus,inspectedNode]);
  const nextPlan = planContext?.proposals.find((proposal) => proposal.id === nextPlanId) ?? null;
  const nextItems = rankEffortNext({ rows: rollupControlResults(history), relationships: pkg.map.edges, postureLabel: pkg.catalog.label }).filter((item) => {
    const plans = planContext?.proposals.filter((proposal) => proposal.controlId === item.controlId) ?? [];
    return providerExtent(subset?.controls.find(c=>c.id===item.controlId)??pkg.controls.find(c=>c.id===item.controlId))!=="all" && !(plans.length > 0 && plans.every((proposal) => proposal.closureConfirmed)) && !nextFocus.dismissed.includes(item.id);
  });
  const closedPlans = (planContext?.proposals ?? []).filter((proposal) => proposal.closureConfirmed);
  function openNext(item: (typeof nextItems)[number]) {
    const plans = planContext?.proposals.filter((proposal) => proposal.controlId === item.controlId && !proposal.closureConfirmed) ?? [];
    const proposals = proposalCounts?.get(item.controlId) ?? 0;
    if (item.kind === "open-finding" && plans[0]) { select(item.controlId); setNextPlanId(plans[0].id); return; }
    // Suggested files stay on the map: select the control so its Evidence card lists them.
    // "Review suggested files →" in that card is the explicit route to Release evidence.
    if (item.kind === "blank" && proposals > 0) { select(item.controlId); return; }
    select(item.controlId);
    changeLevel2(true);
  }
  const selector = (
    <ReleaseSnapshot
      history={history}
      record={record}
      highlighted={highlighted}
      onChange={(next) => {
        setLocalHighlighted(Boolean(next));
        onHighlightChange?.(Boolean(next));
        if (next) onRecordChange(next);
      }}
    />
  );
  const linked = pkg.controls.filter((c) => c.rollupState === "recorded");
  const summary=(<div className="round21-summary pmap-evidence-actions"><label><input type="checkbox" checked={allFamilies} onChange={e=>showAll(e.target.checked)}/> Show untouched controls</label><button onClick={onRelease}>Release evidence →</button></div>);
  return (
    <div
      className={`rollup-map-workspace round21-workspace package-map-r2${level2 || roleFocus || evidenceId ? " is-focus" : ""}`}
      data-testid="rollup-map-workspace"
    >
      {!level2 && !roleFocus && !evidenceId && <NextWorkBand ownerPackage={subset??undefined} items={nextItems} hasHistory={Boolean(history.length)} proposalCounts={proposalCounts} hasPlan={id=>Boolean(planContext?.proposals.some(p=>p.controlId===id&&!p.closureConfirmed))} onOpen={item=>openNext(item as (typeof nextItems)[number])}/>}

      <div className={`workspace${(selected || familyId || inspectedNode) && !evidenceId && !roleFocus ? "" : " map-only"}`}>
        <div className="map-col chrome-map-col">
          {roleFocus ? <section className="map-role-focus" data-testid="map-role-focus"><header><span className="kicker">Level 2 · responsible role</span><h2>{roleFocus.title}</h2><button type="button" className="btn ghost" onClick={()=>setRoleFocus(null)}>← Map Esc</button></header><p>Controls assigned to this role. Open a control to inspect its statements and evidence.</p><RoleCardBody pkg={mapPkg} roleId={roleFocus.id} onOpen={id=>{select(id);changeLevel2(true);}} /></section> : evidenceId && record.schema === "aegis.evidence-event.v1" && selected ? <ObservedEvidenceFocus pkg={pkg} control={selected} record={record} history={history} evidenceId={evidenceId} onLeave={() => setEvidenceId(null)} onOpenControl={(id,item)=>{setEvidenceId(null);select(id);setItemId(item);setLevel2(true);}} /> : evidenceId ? <EvidenceFocus pkg={pkg} evidenceId={evidenceId} returnControlId={level2 ? selectedId ?? undefined : undefined} onLeave={() => setEvidenceId(null)} onOpenControl={(id, item) => { select(id); setItemId(item); setLevel2(true); }} /> : level2 && original ? (
            <Round21Focus
              pkg={focusPkg}
              control={original}
              pipelineControl={highlighted ? selected : undefined}
              observed={record.schema === "aegis.evidence-event.v1"}
              observedRecord={history.find(r=>r.pipelineId===selected?.rollupReleaseId&&selected.evidence.some(e=>e.id.includes(r.releaseSha256)))??record}
              selectedItemId={itemId}
              onSelectItem={changeItem}
              onBack={() => changeLevel2(false)}
              onSelect={select}
              onEvidence={() => {
                const link = document.querySelector<HTMLAnchorElement>(
                  ".round21-source-artifact",
                );
                link?.scrollIntoView({ block: "nearest" });
                link?.focus();
              }}
              onInspectEvidence={setEvidenceId}
              snapshotSelector={selector}
            />
          ) : (
            <PackageMap
              initialShowMissing
              providerLegend={{available:metadata.sources.provider!=="empty",example:metadata.pkg.controls.some(c=>c.providerCoverage?.some(entry=>entry.provider.example))}}
              ownerFilterPackage={metadata.pkg} ownerFilter={owner} onOwnerFilterChange={setOwner} exampleOwners={metadata.sources.owners==="example"}
              showUntouched={allFamilies}
              inspectedNode={inspectedNode}
              onInspectNode={inspectNode}
              onOpenEvidenceFocus={setEvidenceId}
              relatedEnabled={relatedEnabled}
              onRelatedChange={changeRelated}
              viewMode={viewMode}
              onViewModeChange={changeMode}
              pkg={mapPkg}
              statementPackage={subset}
              pipelineEvidence={history.length ? record : undefined}
              pipelineHistory={history}
              pipelineArtifact={pipelineArtifact}
              onSelectPipelineArtifact={onSelectPipelineArtifact}
              releaseCoverage={highlighted ? pkg : undefined}
              snapshotSelector={selector}
              workspaceNotice={workspaceNotice}
              coverageSummary={summary}
              packageControlIds={packageControlIds}
              selectedId={selectedId}
              level2={false}
              selectedItemId={null}
              onSelect={select}
              reviewControlIds={reviewControlIds}
              planStateLabels={planStateLabels}
              proposalCounts={proposalCounts}
              snapshotProposalCounts={snapshotProposalCounts}
              recordedControlIds={recordedControlIds}
              selectedFamilyId={familyId}
              onSelectFamily={changeFamily}
              onEnterFocus={(id) => {
                select(id);
                changeLevel2(true);
              }}
              onLeaveFocus={() => changeLevel2(false)}
              onSelectItem={changeItem}
              onClearSelection={close}
              onOpenControlFocus={(id) => {
                select(id);
                changeLevel2(true);
              }}
            />
          )}
        </div>
        {inspectedNode && !evidenceId && !roleFocus && <aside className="panel round21-panel map-node-panel r2-side-panel" data-testid="map-node-panel" data-kind={inspectedNode.kind}><header className="panel-head"><span className="kicker">{inspectedNode.kind==="role"?"Responsible role":"SSP evidence"}</span><button type="button" className="panel-close" aria-label="Close panel" onClick={()=>setInspectedNode(null)}>×</button></header><div className="map-node-panel-body" data-testid={inspectedNode.kind==="role"?"role-card":"evidence-card"}>{inspectedNode.kind==="role"?<RoleCardBody pkg={mapPkg} roleId={inspectedNode.id} onOpen={select}/>:<EvidenceCardBody focusLabel="Open evidence in Level 2 →" pkg={mapPkg} evidence={{...inspectedNode,uuid:inspectedNode.uuid??inspectedNode.id}} onOpen={()=>setEvidenceId(inspectedNode.id)} onOpenControl={select}/>}</div>{inspectedNode.kind==="role" && <footer><button type="button" className="btn primary" onClick={()=>setRoleFocus(inspectedNode)}>Open role in Level 2 →</button></footer>}</aside>}
        {familyId && !selected && !evidenceId && !inspectedNode && !roleFocus && <MapFamilyPanel owner={owner} onOwnerChange={setOwner} metadataSources={metadata.sources} pkg={metadata.pkg} familyId={familyId} results={results} onClose={()=>changeFamily(null)} onSelect={select} />}
        {selected && !evidenceId && !inspectedNode && !roleFocus && (
          <PipelineControlPanel
            pkg={metadata.pkg}
            metadataSources={metadata.sources} owner={owner} onOwnerChange={setOwner}
            control={metadata.pkg.controls.find(c=>c.id===selected.id)??selected}
            planStateLabel={planStateLabels.get(selected.id)}
            proposalCount={snapshotProposalCounts?.get(selected.id)??proposalCounts?.get(selected.id)}
            result={highlighted ? (results.get(selected.id) ?? null) : null}
            level2={level2}
            selectedItemId={itemId}
            onInspectEvidence={setEvidenceId}
            onClose={close}
            onExpand={() => changeLevel2(true)}
            packageControlIds={subset?.controls.map((c) => c.id)}
            onSelect={select}
            onShowAll={() => showAll(true)}
            onRelease={onRelease}
            onBack={() => changeLevel2(false)}
            history={snapshotHistory}
          />
        )}
      </div>
      {nextPlan && <PlanProposalDrawer proposal={nextPlan} onClose={() => setNextPlanId(null)} />}
    </div>
  );
}

export function PipelineControlPanel({
  pkg,
  control,
  result,
  level2,
  selectedItemId,
  onInspectEvidence,
  onClose,
  onExpand,
  packageControlIds,
  onSelect,
  onShowAll,
  onRelease,
  onBack,
  history,
  planStateLabel,
  proposalCount = 0,
  metadataSources,owner="",onOwnerChange=()=>{},
}: {
  pkg: PackageState;
  control: ControlView;
  result: ProvenResult | null;
  level2: boolean;
  selectedItemId?: string | null;
  onInspectEvidence?: (id:string)=>void;
  onClose: () => void;
  onExpand: () => void;
  packageControlIds?: string[];
  onSelect?: (id: string) => void;
  onShowAll?: () => void;
  onRelease?: () => void;
  onBack?: () => void;
  history?: PipelineEvidence[];
  planStateLabel?: string;
  proposalCount?: number;
  metadataSources?:MapMetadataSources;owner?:string;onOwnerChange?:(value:string)=>void;
}) {
  const provider=providerExtent(control);
  const links = directedLinksFor(pkg.map.edges, control.id);
  const statement = level2 && selectedItemId ? pkg.map.statements[control.id]?.items.find(i=>i.id===selectedItemId) : null;
  const primary =
    control.id === "CM-6"
      ? control.evidence.find((e) => e.title === "configuration.json")
      : undefined;
  const evidence = result ? (primary ? [primary] : control.evidence) : [];
  const ids = new Set(packageControlIds ?? pkg.controls.map((c) => c.id));
  const visible = [...links.mutual, ...links.outbound, ...links.reverse].filter(
    (l) => ids.has(l.otherId),
  );
  const offMap = [...links.mutual, ...links.outbound, ...links.reverse].filter(
    (l) =>
      !ids.has(l.otherId) &&
      pkg.controls.some(
        (c) => c.id === l.otherId && c.rollupState === "recorded",
      ),
  );
  const hidden = [...links.mutual, ...links.outbound, ...links.reverse].filter(
    (l) => !ids.has(l.otherId) && !offMap.includes(l),
  );
  const priorFindings = result ? (history ?? []).flatMap(release => (release.reviewItems ?? []).flatMap(item => {
    const scoped = resultForReviewItem(release, item, control.id, history ?? []);
    return scoped?.finding && !(scoped.sourceReleaseSha256 === result.sourceReleaseSha256 && scoped.reviewItemId === result.reviewItemId) ? [scoped] : [];
  })) : [];
  // Pin the original finding by provenance, never by whether someone accepted it.
  const primaryFinding = [result, ...priorFindings].filter((r): r is ProvenResult => Boolean(r?.finding)).sort((a,b)=>(a.sourceCreatedAt ?? a.createdAt).localeCompare(b.sourceCreatedAt ?? b.createdAt) || a.finding.localeCompare(b.finding))[0];
  const primaryPlan = useResolvedProposal(control.id, primaryFinding?.finding ?? "", history);
  const plansContext=usePlanProposals();
  const controlPlans=(plansContext?.proposals ?? proposePlans(history??[])).filter(plan=>plan.controlId===control.id&&!plan.closureConfirmed);
  const [openCard,setOpenCard]=useState<"next"|"evidence"|null>(controlPlans.length?"next":"evidence");
  const [actionPlan,setActionPlan]=useState<string|null>(null);
  useEffect(()=>{setOpenCard(controlPlans.length?"next":"evidence");setActionPlan(null);},[control.id]);
  const selectedActionPlan=controlPlans.find(plan=>plan.id===actionPlan);
  const statusText = result?.mappingStatus === "proposed" ? "◌ Proposed finding · mapping needs review" : result
    ? "● Evidence linked · coverage only"
    : proposalCount ? "Proposed mapping · not accepted" : "Blank · no evidence linked";
  // Block colors follow the package map: red finding, teal linked, amber proposed.
  const statusTone = primaryFinding?.finding ? "fail" : result?.mappingStatus === "proposed" || (!result && proposalCount) ? "proposed" : result ? "linked" : "blank";
  const proposedOnly = result?.mappingStatus === "proposed" || (!result && proposalCount > 0);
  const relatedCount = links.mutual.length + links.outbound.length + links.reverse.length;
  const relatedFamilies = new Set([...links.mutual,...links.outbound,...links.reverse].map(l=>l.otherId.split("-")[0])).size;
  const renderFinding = (finding: ProvenResult) => {
    const source = history?.find(r=>r.releaseSha256===finding.sourceReleaseSha256);
    const capturedFailure=source?.schema === "aegis.evidence-event.v1" && source.observation.checks.some(c=>observationControl(c)===control.id && c.verdict === "fail");
    return (
    <section className="panel-block">
      <div className="label-row">
        <span className="kicker">{capturedFailure ? "Original finding" : `Finding on ${control.id}`}</span>{capturedFailure && <span className="pill fail">Captured FAIL</span>}
      </div>
      {finding.findingTitle ? <strong className="pipeline-control-title">{finding.findingTitle}</strong> : null}
      <p className="pipeline-control-finding">{finding.finding}</p>
      <details className="control-retest"><summary>Details</summary><p>{finding.finding}</p><small className="snapshot-retest-count" title="Only retest checks retained through the selected snapshot are counted here.">Retest checks in this snapshot: {finding.checks.length} · source #{receiptLabel(finding.sourceReleaseId)}</small><ol className="pipeline-control-checks">
        {finding.checks.map((check, i) => (
          <li key={check.description}>
            <strong>
              {i + 1}　{check.description}
            </strong>
            {check.reportedVerdict && <small>Captured {check.reportedVerdict.toUpperCase()} · evidence {freshnessLabel(check.evidenceState ?? "unknown")}</small>}
            <details>
              <summary>Result and check evidence</summary>
              <span>{check.result}</span>
              {check.href && (
                <a href={evidenceViewerHref(check.href, undefined, history?.find(r=>r.releaseSha256===finding.releaseSha256))} target="_blank" rel="noopener noreferrer">
                  Check evidence ↗
                </a>
              )}
            </details>
          </li>
        ))}
      </ol></details>
    </section>
  );};
  const findings = <>
    {result?.finding && renderFinding(result)}
    {priorFindings.map(finding => <details key={`${finding.sourceReleaseSha256}:${finding.reviewItemId}`} className="panel-block"><summary>Separate finding · {finding.findingTitle} · {countLabel(finding.checks.length,"retest check")}</summary>
      <p className="hint">This finding and its retest have their own scope. A pass does not resolve another finding on {control.id}.</p>
      {renderFinding(finding)}
      <ProposedPlanSummary controlId={control.id} finding={finding.finding} history={history} />
    </details>)}
  </>;
  if(!level2) return <aside className="panel planning-panel pipeline-control-panel round21-panel accordion-control-panel r2-side-panel" aria-label={`${control.id} pipeline evidence`} data-testid="pipeline-control-panel">
    <header className="panel-head"><div className="label-row"><h2><span className="mono panel-id">{control.id}</span> <span className="panel-name">{control.title}</span></h2><button className="icon-btn" aria-label="Close panel" onClick={onClose}>×</button></div><div className="accordion-control-status"><span className={`pill ${provider==="all"?"provider":proposedOnly?'warn':result?'pass':''}`}>{provider==="all"?"◆ Covered by provider":proposedOnly?'◌ Proposed mapping · not accepted':result?'● Evidence linked':'○ No evidence yet'}</span><button className="text-btn" onClick={onExpand}>Open in Level 2 →</button><MapMetadataPanel pkg={pkg} controls={[control]} sources={metadataSources} owner={owner} onOwnerChange={onOwnerChange}/></div></header>
    <div className="panel-scroll">
      {controlPlans.length>0&&<section className="side-card" data-side="next" data-decision-needed={controlPlans.some(planNeedsDecision)?"true":"false"}><button type="button" className="side-card-toggle" aria-expanded={openCard==='next'} aria-controls={`control-actions-${control.id}`} onClick={()=>setOpenCard(openCard==='next'?null:'next')}><span>Next action</span><b>{controlPlans.filter(planNeedsDecision).length ? `${controlPlans.filter(planNeedsDecision).length} need your decision`:'Waiting on a retest'}</b><i>{openCard==='next'?'▾':'▸'}</i></button>{openCard==='next'&&<div id={`control-actions-${control.id}`} className="control-action-rows">{[...controlPlans].sort((a,b)=>Number(a.readyToClose)-Number(b.readyToClose)).map(plan=><article key={plan.id}><div><strong title={plan.findingTitle}>{(plan.findingTitle.match(/\b[A-Z]{2,6}-\d{3,5}\b/)||[])[0]||plan.findingTitle.replace(/^Application /,"")}</strong><small>{plan.readyToClose?'Fixed · retest passed':plan.acceptance==='accepted'?'Waiting on a retest':'Not fixed · plan drafted'}</small></div><button type="button" className="btn primary" aria-label={`Open ${plan.controlId} plan: ${plan.findingTitle}`} disabled={!plansContext||plansContext.loading} onClick={()=>setActionPlan(plan.id)}>{!plansContext||plansContext.loading?'Loading saved plan…':plan.readyToClose?'Confirm closure':plan.acceptance==='accepted'?'Open plan':'Review plan'}</button></article>)}</div>}</section>}
      <section className="side-card" data-side="evidence"><button type="button" className="side-card-toggle" aria-expanded={openCard==='evidence'||!evidence.length} aria-controls={`control-evidence-${control.id}`} disabled={!evidence.length} onClick={()=>setOpenCard(openCard==='evidence'?null:'evidence')}><span>Evidence</span><small>{evidence.length?`${evidence.length} file${evidence.length===1?'':'s'}`:''}</small>{evidence.length?<i>{openCard==='evidence'?'▾':'▸'}</i>:null}</button>{(openCard==='evidence'||!evidence.length)&&<div id={`control-evidence-${control.id}`}>
        {evidence.map(e=><div key={e.id} className="pipeline-control-artifact">{e.href?<a href={evidenceViewerHref(e.href,undefined,history?.find(r=>r.releaseSha256===result?.releaseSha256))} data-source-href={e.href} title={e.title} target="_blank" rel="noopener noreferrer">{e.title} ↗</a>:<b>{e.title}</b>}<small>{CONTROL_PANEL.controlLevel}</small>{e.source?<p className="hint"><SourceRepo source={e.source}/></p>:e.systemSources?.length?<p className="hint"><SystemSources sources={e.systemSources} stacked/></p>:null}</div>)}
        {!evidence.length&&<p className="hint">{provider==="all"?"Not needed from you":"None linked"}</p>}{proposalCount>0&&<button type="button" className="suggested-review" onClick={onRelease} title={`${proposalCount} suggested files`}>Review suggested files →</button>}
      </div>}</section>
      <details className="side-related"><summary>{CONTROL_PANEL.related(relatedCount,relatedFamilies)}</summary><div className="round21-panel-links">{[...visible,...offMap,...hidden].map(link=><button key={link.otherId} type="button" onClick={()=>{if(!ids.has(link.otherId))onShowAll?.();onSelect?.(link.otherId);}}>{links.mutual.includes(link)?'⇄':links.outbound.includes(link)?'→':'←'} {link.otherId}</button>)}</div></details>
    </div>{selectedActionPlan&&<PlanProposalDrawer proposal={selectedActionPlan} onClose={()=>setActionPlan(null)}/>}
  </aside>;
  return (
    <aside
      className="panel planning-panel pipeline-control-panel round21-panel"
      aria-label={`${control.id} pipeline evidence`}
      data-testid="pipeline-control-panel"
    >
      <header className="panel-head">
        <div className="label-row">
          {statement ? <div><span className="kicker">Statement · selected</span><h2 className="mono">{statement.id}</h2><span className="pill">Not addressed</span></div> : level2 ? (
            <div>
              <span className="kicker">Release evidence · selected</span>
              <h2 className="mono">{evidence[0]?.title ?? control.id}</h2>
            </div>
          ) : (
            <h2>
              <span className="mono panel-id">{control.id}</span>{" "}
              <span className="panel-name">{control.title}</span>
            </h2>
          )}
          <button
            className="icon-btn"
            aria-label="Close panel"
            onClick={onClose}
          >
            ×
          </button>
        </div>
        {(statement || level2) && <span className="pipeline-control-status">{statusText}</span>}
        {(planStateLabel || result?.finding) && (
          <span className="pipeline-control-review" data-testid="control-plan-status">{planStateLabel ?? "Needs review"}</span>
        )}
      </header>
      <div className="panel-scroll">
        {(statement || level2) && proposalCount > 0 && <section className="panel-block" data-testid="control-proposed-evidence"><span className="kicker">Mapping proposals · {proposalCount}</span><p className="hint">Agent proposes · person approves · coverage only. These suggestions add no linked evidence.</p>{!!control.proposedEvidence?.length && <details><summary>Inspect sources and facts</summary>{control.proposedEvidence.map(p=><div key={p.key ?? p.artifact}><strong>{p.sourcePath ?? p.artifact}</strong>{p.source && <p className="hint"><SourceRepo source={p.source}/></p>}{p.reasons.map(reason=><p className="hint" key={reason}>{reason}</p>)}</div>)}</details>}<button type="button" className="text-btn" onClick={onRelease}>Review artifact proposals →</button></section>}
        {statement ? <section className="panel-block"><span className="kicker">Evidence for this statement</span><p className="hint">No item-level evidence linked.</p>{evidence[0] && <button className="statement-inspect" type="button" aria-label="Inspect evidence details" onClick={()=>onInspectEvidence?.(evidence[0].id)}>{evidence.length} release artifacts · control level <b>Inspect evidence →</b></button>}<div className="statement-artifact-links">{evidence.map(e=><a className="round21-source-artifact" key={e.id} href={evidenceViewerHref(e.href,undefined,history?.find(r=>r.releaseSha256===result?.releaseSha256))} data-source-href={e.href} target="_blank" rel="noopener noreferrer">{e.title} ↗</a>)}</div><p className="hint">Supports {control.id} as a whole. Not assigned to this statement.</p></section> : level2 ? (
          <section className="panel-block">
            <span className="kicker">Source</span>
            <dl className="round21-source">
              <dt>Release</dt>
              <dd>
                {result ? (
                  <a
                    href={evidenceViewerHref(result.releaseUrl, undefined, history?.find(r=>r.releaseSha256===result.releaseSha256))}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {systemLabel(result.releaseUrl,history)}{" "}
                    <b className="mono">#{receiptLabel(result.releaseId)}</b> ↗
                  </a>
                ) : (
                  "None"
                )}
              </dd>
              <dt>Snapshot</dt>
              <dd>{result ? utcTime(result.createdAt,true) : "—"}</dd>
              <dt>Supports</dt>
              <dd>
                <b className="mono">{control.id}</b> · control level
              </dd>
              <dt>Statements</dt>
              <dd title="The retained producer declared control-level scope. Human statement reviews are shown separately in Level 2.">not mapped by producer</dd>

            </dl>
            {evidence.map((e) => (
              <a
                className="round21-source-artifact"
                key={e.id}
                href={evidenceViewerHref(e.href, undefined, history?.find(r=>r.releaseSha256 === result?.releaseSha256))} data-source-href={e.href}
                target="_blank"
                rel="noopener noreferrer"
              >
                {e.title} ↗
              </a>
            ))}
          </section>
        ) : (
          <>
            <section className="side-card" data-side="status" data-tone={statusTone}>
              <h3>{CONTROL_PANEL.status}</h3>
              <span className="pipeline-control-status">{statusText}</span>
              {primaryFinding?.finding ? findings : null}
            </section>
            <section className="side-card" data-side="evidence">
              <h3>{CONTROL_PANEL.evidence}</h3>
              {evidence.map((e) => (
                <div key={e.id} className="pipeline-control-artifact">
                  {e.href ? (
                    <a href={evidenceViewerHref(e.href, undefined, history?.find(r=>r.releaseSha256 === result?.releaseSha256))} data-source-href={e.href} title={e.title} target="_blank" rel="noopener noreferrer">
                      {e.title} ↗
                    </a>
                  ) : (
                    <b title={e.title}>{e.title}</b>
                  )}
                  <small>{CONTROL_PANEL.controlLevel}</small>
                  {e.source ? <p className="hint"><SourceRepo source={e.source}/></p> : e.systemSources?.length ? <p className="hint"><SystemSources sources={e.systemSources} stacked/></p> : null}
                </div>
              ))}
              {!evidence.length && <p className="hint">{CONTROL_PANEL.noEvidence}</p>}
              {proposalCount > 0 && <button type="button" className="text-btn" onClick={onRelease}>Review {proposalCount} mapping proposals →</button>}
            </section>
            <details className="side-related" data-side="related">
              <summary>{CONTROL_PANEL.related(relatedCount, relatedFamilies)}</summary>
              <div className="round21-panel-links">
                {visible.slice(0, 6).map((l) => (
                  <button
                    key={l.otherId}
                    className={
                      pkg.controls.find((c) => c.id === l.otherId)
                        ?.rollupState === "recorded"
                        ? "linked"
                        : ""
                    }
                    onClick={() => onSelect?.(l.otherId)}
                  >
                    {links.mutual.includes(l)
                      ? "⇄"
                      : links.outbound.includes(l)
                        ? "→"
                        : "←"}{" "}
                    {l.otherId}
                  </button>
                ))}
              </div>
              {visible.length > 6 && <details className="round21-other-links"><summary>{visible.length - 6} more</summary>{visible.slice(6).map((l) => (
                <button key={l.otherId} onClick={() => onSelect?.(l.otherId)}>{l.otherId}</button>
              ))}</details>}
              {offMap.length > 0 && (
                <p className="hint">
                  Off map, release-linked:{" "}
                  {offMap.map((l) => (
                    <button
                      key={l.otherId}
                      className="text-btn"
                      onClick={() => {
                        onShowAll?.();
                        onSelect?.(l.otherId);
                      }}
                    >
                      {l.otherId}
                    </button>
                  ))}{" "}
                  ·{" "}
                  <button className="text-btn" onClick={onShowAll}>
                    Show untouched controls
                  </button>
                </p>
              )}
              {hidden.length > 0 && (
                <details className="round21-other-links" open>
                  <summary>{hidden.length} more catalog links</summary>
                  {hidden.map((l) => (
                    <button
                      key={l.otherId}
                      onClick={() => {
                        onShowAll?.();
                        onSelect?.(l.otherId);
                      }}
                    >
                      {l.otherId}
                    </button>
                  ))}
                </details>
              )}
            </details>
          </>
        )}
        {(statement || level2) && findings}
        {level2 && primaryFinding?.finding ? <ProposedPlanSummary controlId={control.id} finding={primaryFinding.finding} history={history} /> : null}
      </div>
      {!level2 && <div className="control-plan-pinned side-card" data-side="next">
        <h3>{CONTROL_PANEL.next}</h3>
        {primaryFinding?.finding && primaryPlan ? <ProposedPlanSummary controlId={control.id} finding={primaryFinding.finding} history={history} primary /> : <button className="btn primary" onClick={onExpand}>
          Open {control.id} in Level 2 →
        </button>}
      </div>}
      {(level2 || (primaryFinding?.finding && primaryPlan)) && <footer className="pipeline-control-footer">
        {level2 ? (
          <div className="label-row">
            <button className="text-btn" onClick={onBack}>
              ← Map
            </button>
            <button className="text-btn" onClick={onRelease}>
              Release evidence →
            </button>
          </div>
        ) : (
          <button className="text-btn" onClick={onExpand}>
            Open {control.id} in Level 2 →
          </button>
        )}
      </footer>}
    </aside>
  );
}

export function MapFamilyPanel({pkg,familyId,results,onClose,onSelect,metadataSources,owner="",onOwnerChange=()=>{}}:{pkg:PackageState;familyId:string;results:Map<string,ProvenResult|null>;onClose:()=>void;onSelect:(id:string)=>void;metadataSources?:MapMetadataSources;owner?:string;onOwnerChange?:(value:string)=>void}) {
  const entries=pkg.controls.filter(c=>c.family===familyId),linked=entries.filter(c=>c.rollupState === "recorded"),blank=entries.filter(c=>c.rollupState !== "recorded"),relations=familyRelationships(pkg.map.edges,familyId);
  return <aside className="panel planning-panel round21-panel r2-side-panel" aria-label={`${familyId} family evidence`} data-testid="map-family-panel"><header className="panel-head"><div className="label-row"><h2><span className="mono panel-id">{familyId}</span> {pkg.map.families.find(f=>f.id===familyId)?.title}</h2><button className="icon-btn" type="button" onClick={onClose} aria-label="Close family panel">×</button></div><div className="family-panel-counts"><b>{linked.length} linked</b><span>{blank.length} blank</span></div><p className="hint">{entries.length} Rev5 Moderate entries · latest result per control</p><MapMetadataPanel pkg={pkg} controls={entries} sources={metadataSources} owner={owner} onOwnerChange={onOwnerChange}/></header><div className="panel-scroll"><section className="panel-block"><span className="kicker">Linked · {linked.length}</span>{linked.map(control=><div key={control.id} className="family-panel-control"><button type="button" className="text-btn" onClick={()=>onSelect(control.id)}><strong>{control.id}</strong> {control.title} →</button>{results.get(control.id)?.finding && <span className="pill miss">Needs review</span>}<p className="hint">{control.evidence.length} pipeline artifacts · control level</p>{control.evidence.map(e=><a key={e.id} href={evidenceViewerHref(e.href)} data-source-href={e.href} target="_blank" rel="noreferrer">{e.title} ↗</a>)}</div>)}{!linked.length&&<p className="hint">No evidence linked in this family.</p>}</section><section className="panel-block"><span className="kicker">Blank · {blank.length}</span><p className="hint">No evidence linked. Blank means no evidence, not noncompliance.</p><details><summary>Inspect blank entries →</summary><div className="round21-panel-links">{blank.map(c=><button type="button" key={c.id} title={c.title} onClick={()=>onSelect(c.id)}>{c.id}</button>)}</div></details></section><section className="panel-block"><div className="label-row"><span className="kicker">Related families · catalog</span><small>{relations.length} families</small></div><div className="family-panel-relations">{relations.map(f=><div key={f.id}><strong>{f.id}</strong><span>{f.mutual>0&&`⇄${f.mutual} `}{f.outbound>0&&`→${f.outbound} `}{f.reverse>0&&`←${f.reverse}`}</span></div>)}</div><p className="hint">⇄ both list · → {familyId} lists · ← other lists {familyId}. Not evidence mappings.</p></section></div><footer className="pipeline-control-footer"><p className="hint">Select a control to trace its directed relationships.</p></footer></aside>;
}
