"use client";
import {releaseFixedControls, releaseEvidenceHref} from "@/lib/aegis/release-evidence";
import {MapOwnerPicker,ownerMatches,missingFieldsInSsp} from "./MapOwnerPicker";
import {MapZoomControl} from "./MapZoomControl";
import {packageMapFocus,type FocusLayout,type FocusSpoke} from "@/lib/aegis/package-map-focus";
import {providerBoxes,providerExtent} from "@/lib/aegis/provider-coverage";
import {zoomAt,fitMap,fitBox,revealBox,unionBox,type MapBox,type MapZoom} from "@/lib/aegis/map-zoom";
import {evidenceLinesVisible} from "@/lib/aegis/map-line-visibility";
import {mapEvidenceFiles} from "@/lib/aegis/map-evidence-files";
import {MapControlFace} from "./MapControlFace";
import {familyViewport} from "@/lib/collector/family-viewport";
import { countLabel } from "@/lib/builder/presentation";
import {accountScanSummary,awsArtifactTitle,plantedAwsArtifact} from "@/lib/collector/aws/summary";

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { treePath } from "@/lib/aegis/selected-tree";
import { attachmentRouter, evidenceTreeKey, familyRoutes, pillRoute, relatedRoutes, roleTreeKey, withinRoutes, type RelatedRoute } from "@/lib/aegis/map-routes";
import { familyRelationships } from "@/lib/aegis/map-view";
import {FAMILY_CODE_PX,FAMILY_TITLE_PX,FAMILY_COUNT_PX} from "@/lib/aegis/package-map-r2";
import {compactFaceLines} from "@/lib/aegis/compact-face";
import { ControlFocus, useStageSize } from "./ControlFocus";
import { EvidenceFocus } from "./EvidenceFocus";
import { directedLinksFor, scopeChip, statementCoverage } from "@/lib/aegis/map-view";
import { buildLayout, evidenceKey, roleCardObstacles, type LayoutControl } from "@/lib/aegis/map-placement";
import {
  CARD_GAP,
  CARD_W,
  EVIDENCE_H,
  ROLE_H,
  controlFaceStatus,
  evidenceCardSpot,
  evidenceDisplayTitle,
  faceLines,
  manropeWidth,
  roleCardSpot,
  spread,
  stageFillHeight,
} from "@/lib/aegis/map-layout";
import type { PackageState } from "@/lib/aegis/types";
import { controlsForArtifact, gitlabArtifactUrl, pipelineArtifactNames, type PipelineEvidence } from "@/lib/aegis/pipeline-evidence";

type Mode = "family" | "selected";
const SIDE_PANEL_ROOM=344;
export type MapNodeSelection={kind:"role"|"evidence";id:string;title:string;controlIds:string[];uuid?:string;displayId?:string};

type Props = {
  pkg: PackageState;
  ownerFilterPackage?:PackageState;
  ownerFilter?:string;
  onOwnerFilterChange?:(value:string)=>void;
  exampleOwners?:boolean;
  providerLegend?:{available:boolean;example:boolean};
  packageControlIds?: string[];
  releaseCoverage?: PackageState | null;
  statementPackage?: PackageState | null;
  initialShowMissing?: boolean;
  showUntouched?:boolean;
  inspectedNode?:MapNodeSelection|null;
  onInspectNode?:(node:MapNodeSelection|null)=>void;
  onOpenEvidenceFocus?:(id:string)=>void;
  snapshotSelector?: ReactNode;
  viewMode?: Mode;
  relatedEnabled?:boolean;
  workspaceNotice?:React.ReactNode;
  onRelatedChange?:(value:boolean)=>void;
  onViewModeChange?: (mode:Mode)=>void;
  coverageSummary?: ReactNode;
  pipelineEvidence?: PipelineEvidence;
  pipelineHistory?:PipelineEvidence[];
  pipelineArtifact?: string | null;
  onSelectPipelineArtifact?: (artifact: string | null) => void;
  selectedId: string | null;
  level2: boolean;
  selectedItemId: string | null;
  reviewControlIds?: ReadonlySet<string>;
  planStateLabels?: ReadonlyMap<string, string>;
  proposalCounts?: ReadonlyMap<string, number>;
  snapshotProposalCounts?:ReadonlyMap<string,number>;
  recordedControlIds?:ReadonlySet<string>;
  selectedFamilyId?: string | null;
  onSelectFamily?: (id: string | null) => void;
  onSelect: (id: string) => void;
  onEnterFocus: (id: string) => void;
  onLeaveFocus: () => void;
  onSelectItem: (id: string) => void;
  onClearSelection?: () => void;
  onOpenControlFocus?: (controlId: string, itemId: string | null) => void;
};

type Wire = {
  key: string;
  d: string;
  rel: string;
  from?: string;
  to?: string;
  glyph?: string;
  line?: string;
  pairs?: number;
  width: number;
  dash?: string;
  opacity: number;
  markerEnd?: boolean;
  markerStart?: boolean;
  stroke?: string;
  /** Wires of one attachment tree share their trunk. Each group is painted once so the trunk is no darker than its branches. */
  group?: string;
  label?:{x:number;y:number;text:string};
};

/** Opacity every edge type drops to while another item is hovered. */
const HOVER_DIM = 0.35;
/** Floor for an unrelated control card while a control or family has focus; it stays legible.
 * Family frames and headers never dim: the selection is read against the family structure. */
const CARD_DIM = 0.5;
/** Related arc stroke at rest (mock 10b) and under hover. */
const RELATED_REST = 2;
const RELATED_HOVER = 2.5;
const ATTACHMENT_WIDTH = 2;
/** Shown when a hovered or selected control or family has no catalog links on this map. */
const NO_RELATED = "No related controls";
/** A family hover with more pairs than this draws one arc per other family. */
const FAMILY_ARC_LIMIT = 24;
/** Role-card leader. Darker than the role wire, same purple family. */
const ROLE_LEADER = "#6a4cff";
const MAP_STAGE_FLOOR = { width: 1, height: 1 };
/** Things with their own hover; over them the family box under the pointer does not light up. */
const FAMILY_HOVER_SKIP = ".pmap-control, .pmap-evidence, .pmap-role, .pmap-pill, .pmap-within, [data-map-card]";

export function PackageMap({
  pkg,
  ownerFilterPackage,ownerFilter,onOwnerFilterChange,exampleOwners,providerLegend,
  packageControlIds,
  releaseCoverage,
  statementPackage,
  initialShowMissing = false, showUntouched=false,
  inspectedNode,
  onInspectNode,
  onOpenEvidenceFocus,
  snapshotSelector,
  coverageSummary,
  pipelineEvidence, pipelineHistory,
  pipelineArtifact,
  onSelectPipelineArtifact,
  selectedId,
  level2,
  selectedItemId,
  onSelect,
  onSelectFamily,
  selectedFamilyId,
  reviewControlIds,
  planStateLabels,
  proposalCounts,
  snapshotProposalCounts,
  recordedControlIds,
  onEnterFocus,
  onLeaveFocus,
  onSelectItem,
  onClearSelection,
  onOpenControlFocus,
  viewMode,
  relatedEnabled, workspaceNotice,
  onRelatedChange, onViewModeChange,
}: Props) {
  const stageRef = useRef<HTMLDivElement>(null);
  const pointerTarget=useRef<EventTarget|null>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLElement>(null);
  const observedWorkspace = Boolean(snapshotSelector);
  const releaseBundle = pipelineEvidence?.schema === "aegis.evidence-event.v1" ? pipelineEvidence.releaseEvidence : undefined;
  const fixedByRelease = useMemo(() => releaseFixedControls(releaseBundle), [releaseBundle]);
  const showRoles = false;
  const [localOwner,setLocalOwner]=useState("");
  const owner=ownerFilter??localOwner,setOwner=onOwnerFilterChange??setLocalOwner;
  const hasSsp=observedWorkspace?Boolean(statementPackage?.loaded):pkg.loaded;
  const ownerPackage=statementPackage?.loaded?statementPackage:pkg;
  const [lastFocusFamily,setLastFocusFamily]=useState<string|null>(null);
  const [zoom,setZoom]=useState<MapZoom>({scale:1,x:0,y:0});
  const wiresRef=useRef<SVGSVGElement>(null);
  const autoFitKey=useRef<string|null>(null);
  const pan=useRef<{x:number;y:number;startX:number;startY:number;moved:boolean;pointerId:number}|null>(null);
  const [panMode,setPanMode]=useState(false);
  const [panning,setPanning]=useState(false);
  const suppressClick=useRef(false);
  const [showEvidence, setShowEvidence] = useState(true);
  const [showSuggested, setShowSuggested] = useState(true);
  const [showPipeline, setShowPipeline] = useState(true);
  const [visibleArtifacts, setVisibleArtifacts] = useState<string[]>(pipelineArtifact ? [pipelineArtifact] : []);
  const [pipelineHover, setPipelineHover] = useState<string | null>(null);
  const [pipelineOpen, setPipelineOpen] = useState<string | null>(null);
  const [artifactSearch, setArtifactSearch] = useState("");
  const [showMissing, setShowMissing] = useState(initialShowMissing);
  const previousPackage=useRef(pkg);
  useEffect(()=>{
    const changed=previousPackage.current!==pkg;previousPackage.current=pkg;
    if(changed&&!observedWorkspace&&selectedId&&pkg.controls.find(control=>control.id===selectedId)?.missing.length)setShowMissing(true);
  },[pkg,selectedId,observedWorkspace]);
  const [localRelatedOn, setLocalRelatedOn] = useState(true);
  const relatedOn=relatedEnabled ?? localRelatedOn;
  const setRelatedOn=(value:boolean)=>{commitControlSelect();setLocalRelatedOn(value);onRelatedChange?.(value);};
  const [localMode, setLocalMode] = useState<Mode>("family");
  const mode=viewMode ?? localMode;
  const setMode=(next:Mode)=>{setLocalMode(next);onViewModeChange?.(next);};
  const previousMode = useRef<Mode>("family");
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [selectedDot,setSelectedDot] = useState<string|null>(null);
  const [hoverFamily, setHoverFamily] = useState<string | null>(null);
  const [selectedFamily, setSelectedFamily] = useState<string | null>(null);
  useEffect(()=>{if(selectedFamilyId !== undefined)setSelectedFamily(selectedFamilyId);},[selectedFamilyId]);
  const [withinHover, setWithinHover] = useState<string | null>(null);
  const [withinPin, setWithinPin] = useState<string | null>(null);
  const withinFamily = withinPin ?? withinHover;
  useEffect(()=>{if(onInspectNode && !inspectedNode){setRoleId(null);setEvidenceOpen(null);}},[inspectedNode,onInspectNode]);
  const tipTimer = useRef<number | null>(null);
  const familyTipTimer = useRef<number | null>(null);
  const evidenceTimer = useRef<number | null>(null);
  const selectTimer = useRef<number | null>(null);
  const pendingControlSelect = useRef<string | null>(null);
  const [roleId, setRoleId] = useState<string | null>(inspectedNode?.kind==="role"?inspectedNode.id:null);
  const [evidenceOpen, setEvidenceOpen] = useState<string | null>(inspectedNode?.kind==="evidence"?evidenceKey({id:inspectedNode.id,uuid:inspectedNode.uuid??inspectedNode.id}):null);
  const [evidenceFocusId, setEvidenceFocusId] = useState<string | null>(null);
  const evidenceOrigin = useRef<{ controlId: string; itemId: string | null } | null>(null);
  const [tip, setTip] = useState<{ x: number; y: number; text: string; owner: string | null } | null>(null);
  const [cardH, setCardH] = useState(0);
  const panelOpen = Boolean(selectedId || inspectedNode) && !level2 && !evidenceFocusId;
  const stage = useStageSize(stageRef, MAP_STAGE_FLOOR, `${level2}|${evidenceFocusId ?? ""}`);
  const evidenceFiles=useMemo(()=>pipelineEvidence?mapEvidenceFiles(pipelineEvidence,pipelineHistory??[],pkg.controls.map(c=>c.id)):[],[pipelineEvidence,pipelineHistory,pkg.controls]);
  const cloudDefaults=useMemo(()=>evidenceFiles.filter(file=>plantedAwsArtifact(file.collected)).map(file=>file.name),[evidenceFiles]);
  const cloudDefaultsKey=`${pipelineEvidence?.releaseSha256??""}:${cloudDefaults.join(",")}`;
  const appliedCloudDefaults=useRef("");
  useEffect(()=>{if(!cloudDefaults.length||appliedCloudDefaults.current===cloudDefaultsKey)return;appliedCloudDefaults.current=cloudDefaultsKey;setVisibleArtifacts(current=>[...new Set([...current,...cloudDefaults])]);},[cloudDefaultsKey,cloudDefaults]);
  useEffect(()=>{
    const node=stageRef.current;if(!node)return;
    const wheel=(event:WheelEvent)=>{if(!event.ctrlKey&&!event.metaKey)return;event.preventDefault();const rect=node.getBoundingClientRect();setZoom(current=>zoomAt(current,current.scale*Math.exp(-event.deltaY*.002),{x:event.clientX-rect.left+node.scrollLeft,y:event.clientY-rect.top+node.scrollTop}));};
    node.addEventListener("wheel",wheel,{passive:false});return()=>node.removeEventListener("wheel",wheel);
  },[level2,evidenceFocusId]);
  const pipelineFiles = useMemo(()=>evidenceFiles.map(file=>file.name),[evidenceFiles]);
  const pipelineControls=useMemo(()=>new Map(evidenceFiles.map(file=>[file.name,file.controlIds])),[evidenceFiles]);
  const visiblePipelineFiles = useMemo(() => visibleArtifacts.filter(name=>pipelineFiles.includes(name)),[visibleArtifacts,pipelineFiles]);
  const pipelineColumns = Math.max(1, Math.floor((stage.width / 1.5 - 24) / 176));
  const pipelineRows = useMemo(() => {
    const rows:Array<{y:number;h:number}>=[];
    let y=8;
    for(let start=0;start<visiblePipelineFiles.length;start+=pipelineColumns){
      const h=Math.max(48,...visiblePipelineFiles.slice(start,start+pipelineColumns).map(name=>35+Math.ceil(manropeWidth(name,8.5)/156)*13));
      rows.push({y,h});y+=h+8;
    }
    return rows;
  },[visiblePipelineFiles,pipelineColumns]);
  const pipelineLaneH = 0;
  const activeArtifact = pipelineHover ?? pipelineArtifact;

  useEffect(() => {
    if (pipelineArtifact) setVisibleArtifacts((current) => current.includes(pipelineArtifact) ? current : [...current, pipelineArtifact]);
  }, [pipelineArtifact]);
  useEffect(() => { setPipelineOpen(null); setPipelineHover(null); }, [pipelineEvidence]);

  useEffect(() => () => {
    if (selectTimer.current) window.clearTimeout(selectTimer.current);
    if (evidenceTimer.current) window.clearTimeout(evidenceTimer.current);
    if (familyTipTimer.current) window.clearTimeout(familyTipTimer.current);
  }, []);

  useEffect(() => {
    if (!selectedFamily || familyRelatedText(pkg, selectedFamily) !== NO_RELATED) {
      setTip((current) => (current?.owner === "pinned-empty" ? null : current));
    }
  }, [selectedFamily, pkg]);

  useEffect(() => {
    if (selectedId) {
      if(viewMode === undefined)setMode("selected");
      setSelectedFamily(null);
      setRoleId(null);
      setEvidenceOpen(null);
      setEvidenceFocusId(null);
    } else {
      if(viewMode === undefined)setMode(previousMode.current);
    }
  }, [selectedId]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const target = event.target;
      if (target instanceof HTMLElement && target.closest("input, textarea, select, [role=dialog]")) return;
      if (evidenceFocusId) {
        event.preventDefault();
        leaveEvidenceFocus();
        return;
      }
      if (level2) return;
      if (roleId || evidenceOpen || pipelineOpen || withinPin || selectedFamily) {
        event.preventDefault();
        setSelectedFamily(null);
        onSelectFamily?.(null);
        onInspectNode?.(null);
        setRoleId(null);
        setEvidenceOpen(null);
        setPipelineOpen(null);
        setWithinPin(null);
        const active = document.activeElement;
        if (active instanceof HTMLElement) active.blur();
        return;
      }
      if (selectedId) {
        event.preventDefault();
        const active = document.activeElement;
        if (active instanceof HTMLElement) active.blur();
        onClearSelection?.();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [evidenceFocusId, level2, roleId, evidenceOpen, pipelineOpen, withinPin, selectedFamily, selectedId, onClearSelection]);

  const linkedByFamily = new Map(pkg.map.families.map(family => [family.id, pkg.controls.filter(control => control.family === family.id && control.rollupState === "recorded").length]));
  const proposedByFamily = new Map(pkg.map.families.map(family => [family.id, pkg.controls.filter(control => control.family === family.id && (proposalCounts?.get(control.id) ?? 0) > 0).length]));
  const proposalPillIds=useMemo(()=>new Set(observedWorkspace ? pkg.controls.filter(control=>(proposalCounts?.get(control.id) ?? 0)>0 && !(recordedControlIds?.has(control.id) ?? control.rollupState==="recorded")).map(control=>control.id) : []),[observedWorkspace,pkg,proposalCounts,recordedControlIds]);
  const pipeFiles=useMemo(()=>showPipeline&&pipelineEvidence?visiblePipelineFiles.map(name=>({name,controlIds:pipelineControls.get(name)??[],inventory:evidenceFiles.find(f=>f.name===name)?.inventory})):[],[showPipeline,pipelineEvidence,visiblePipelineFiles,pipelineControls,evidenceFiles]);
  const geometryPanelOpen=observedWorkspace?false:panelOpen;
  const touchedIds=useMemo(()=>new Set(pkg.controls.filter(c=>(recordedControlIds?.has(c.id)??c.rollupState==="recorded")||(proposalCounts?.get(c.id)??0)>0||(!observedWorkspace&&c.evidence.length>0)).map(c=>c.id)),[pkg,recordedControlIds,proposalCounts,observedWorkspace]);
  const geometryWidth=stage.width;
  useEffect(()=>{
    if(selectedFamily)setLastFocusFamily(selectedFamily);
    else if(selectedId){const family=pkg.controls.find(c=>c.id===selectedId)?.family;if(family)setLastFocusFamily(family);}
  },[selectedFamily,selectedId,pkg]);
  const hubId=observedWorkspace&&mode==="selected"&&selectedId&&pkg.controls.some(c=>c.id===selectedId)?selectedId:null;
  const sourceForCoverage=(id:string)=>{const control=pkg.controls.find(c=>c.id===id),authored=statementPackage?.controls.find(c=>c.id===id);return control?{...control,providerCoverage:authored?.providerCoverage??control.providerCoverage}:authored;};
  const providers=useMemo(()=>providerBoxes(pkg,statementPackage),[pkg,statementPackage]);
  const baseLayout=useMemo(()=>{
    if(!observedWorkspace)return buildLayout(pkg,stage.width,geometryPanelOpen);
    const options={touchedIds:showUntouched?touchedIds:undefined,showEvidence,pipeFiles,providers,focusFamily:selectedFamily??lastFocusFamily,focusControl:hubId};
    const height=Math.max(300,stage.height-8);
    if(showSuggested)return packageMapFocus(pkg,geometryWidth,height,options);
    return packageMapFocus({...pkg,controls:pkg.controls.filter(c=>!proposalPillIds.has(c.id)||c.id===hubId)},geometryWidth,height,{...options,fixed:{mm:packageMapFocus(pkg,geometryWidth,height,options).mm}});
  },[pkg,stage.width,geometryWidth,stage.height,geometryPanelOpen,observedWorkspace,proposalPillIds,showSuggested,touchedIds,showUntouched,showEvidence,pipeFiles,providers,selectedFamily,lastFocusFamily,hubId]);
  const focusLayout=observedWorkspace?baseLayout as FocusLayout:null;
  // The side panel overlays the right edge (330px plus its shadow gutter); the map scales to sit
  // fully left of it so no family or control is hidden underneath.
  const sidePanelOpen=observedWorkspace&&Boolean(panelOpen||selectedFamilyId);
  const autoScale=observedWorkspace?Math.min(1,Math.max(1,stage.width-(sidePanelOpen?SIDE_PANEL_ROOM:0))/baseLayout.width):1;
  const familyCardSize=(lane:object)=>((baseLayout as {mm?:number}).mm??70)*((lane as {k?:number}).k??1);
  const mapScale=autoScale*zoom.scale;
  /** Marker size in map units for a given on-screen size; the planning map keeps arrowheads legible at any scale. */
  const arrowUnits=(px:number)=>observedWorkspace?+(px/Math.max(.05,mapScale)).toFixed(2):px;
  const cardKind: "role" | "evidence" | "pipeline" | null = level2 || evidenceFocusId
    ? null
    : pipelineOpen ? "pipeline" : observedWorkspace ? null : roleId ? "role" : evidenceOpen ? "evidence" : null;
  const roleBox = roleId ? baseLayout.roles.find((item) => item.id === roleId) ?? null : null;
  const openCardOwner = cardKind === "role" ? `role:${roleId}` : cardKind === "evidence" ? `evidence:${evidenceOpen}` : null;
  const evidenceBox = evidenceOpen ? baseLayout.evidence.find((item) => evidenceKey(item) === evidenceOpen) ?? null : null;
  const cardMaxH = Math.max(120, stage.height / mapScale - 24);
  const shownCardH = Math.min(cardH, cardMaxH);
  const roleSpot = cardKind === "role" && roleBox
    ? roleCardSpot(
      roleBox,
      baseLayout.width,
      CARD_W,
      shownCardH,
      roleCardObstacles(baseLayout, roleBox.controlIds, { bundles: false, pills: showMissing }),
    )
    : null;
  const evidenceSpot = cardKind === "evidence" && evidenceBox
    ? evidenceCardSpot(
      evidenceBox,
      evidenceBox.y + evidenceBox.h,
      baseLayout.width,
      CARD_W,
      shownCardH,
      baseLayout.evidence.filter((item) => item.band === evidenceBox.band && item.row > evidenceBox.row),
    )
    : null;
  // Cards lie over the map; opening one never reflows a row. The canvas only grows to fit a card.
  const layout = baseLayout;
  // Pipeline files are evidence boxes of the layout (r2 export): placed under their main family, routed by attachment trees.
  const plannedPipelineBoxes=useMemo(()=>(layout.evidence as Array<(typeof layout.evidence)[number]&{pipe?:boolean}>).filter(item=>item.pipe).map(item=>({name:item.title,x:item.x,y:item.y,w:item.w,h:48,item})),[layout]);
  // Other maps (the SA-1 demo workspace) keep their earlier file boxes and routes unchanged.
  const legacyPipelineBoxes=observedWorkspace?[]:visiblePipelineFiles.map(name=>{
    const ids=pipelineControls.get(name)??[];
    const host=[...layout.lanes].sort((a,b)=>b.memberIds.filter(id=>ids.includes(id)).length-a.memberIds.filter(id=>ids.includes(id)).length||a.id.localeCompare(b.id))[0];
    if(!host)return null;
    const siblings=visiblePipelineFiles.filter(other=>{
      const links=pipelineControls.get(other)??[];
      return [...layout.lanes].sort((a,b)=>b.memberIds.filter(id=>links.includes(id)).length-a.memberIds.filter(id=>links.includes(id)).length||a.id.localeCompare(b.id))[0]?.id===host.id;
    });
    const ssp=showEvidence?layout.evidence.filter(e=>e.host===host.id).length:0;
    const index=siblings.indexOf(name)+ssp,w=Math.min(140,host.w),cols=Math.max(1,Math.floor((host.w+8)/(w+8)));
    return {name,x:host.x+index%cols*(w+8),y:host.y+host.h+40+Math.floor(index/cols)*56,w,h:48};
  }).filter((box):box is NonNullable<typeof box>=>Boolean(box));
  const pipelineBoxes=observedWorkspace?plannedPipelineBoxes:legacyPipelineBoxes;
  const pipelineBox = pipelineBoxes.find((box) => box.name === pipelineOpen);
  const pipelineSpot = pipelineBox ? evidenceCardSpot(pipelineBox, pipelineBox.y + pipelineBox.h, layout.width, CARD_W, shownCardH, pipelineBoxes.filter((box) => box.y > pipelineBox.y)) : null;

  const selectedLinks = useMemo(() => selectedId ? directedLinksFor(pkg.map.edges,selectedId) : null,[pkg.map.edges,selectedId]);
  const attachments=useMemo(()=>observedWorkspace?{next:()=>false,tree:(_key:string)=>undefined}:attachmentRouter(layout,false),[layout,observedWorkspace]);
  useEffect(()=>{
    let timer=0;
    // Trees are routed in short slices after the layout settles so the first click does not pay for all of them.
    const slice=()=>{
      const until=performance.now()+8;
      let more=true;
      while(more&&performance.now()<until)more=attachments.next();
      if(more)timer=window.setTimeout(slice,0);
    };
    timer=window.setTimeout(slice,0);
    return ()=>window.clearTimeout(timer);
  },[attachments]);
  const arcGeometryCache = useMemo(() => new Map<string,RelatedRoute[]>(),[layout,pkg.map.edges,observedWorkspace]);
  const controlFaces = useMemo(() => new Map(pkg.controls.map(source => {
    const statementSource=statementPackage?.controls.find(control=>control.id===source.id)??source;
    const coverage=statementCoverage(statementSource,statementPackage?.map.statements[source.id]?.items??pkg.map.statements[source.id]?.items??[]);
    return [source.id,{source,coverage}];
  })),[pkg,statementPackage]);
  const releaseControls = useMemo(() => new Map(releaseCoverage?.controls.map(control=>[control.id,control])??[]),[releaseCoverage]);
  const artifactControls = useMemo(() => pipelineEvidence && pipelineArtifact ? controlsForArtifact(pipelineEvidence, pipelineArtifact) : [], [pipelineEvidence, pipelineArtifact]);
  const activeArtifactControls = pipelineEvidence && activeArtifact ? pipelineControls.get(activeArtifact)??[] : [];
  const selectionActive = mode === "selected" && selectedLinks != null && selectedId != null;
  const drawSelected = relatedOn && selectionActive;
  const selectionSet = useMemo(() => {
    if (!selectionActive || !selectedId || !selectedLinks) return null;
    return new Set([
      selectedId,
      ...selectedLinks.mutual.map((link) => link.otherId),
      ...selectedLinks.outbound.map((link) => link.otherId),
      ...selectedLinks.reverse.map((link) => link.otherId),
    ]);
  }, [selectionActive, selectedId, selectedLinks]);
  const emphasis = useMemo(() => {
    if (pipelineHover && pipelineEvidence) return new Set(controlsForArtifact(pipelineEvidence, pipelineHover));
    if (roleId) {
      const role = layout.roles.find((item) => item.id === roleId);
      return role ? new Set(role.controlIds) : null;
    }
    if (evidenceOpen) {
      const evidence = layout.evidence.find((item) => evidenceKey(item) === evidenceOpen);
      return evidence ? new Set(evidence.controlIds) : null;
    }
    if (withinFamily) {
      return new Set(layout.controls.filter((control) => control.family === withinFamily).map((control) => control.id));
    }
    if (pipelineArtifact && !hoverFamily && !selectedFamily) return new Set(artifactControls);
    return selectionSet;
  }, [pipelineHover, pipelineEvidence, pipelineArtifact, hoverFamily, selectedFamily, artifactControls, roleId, evidenceOpen, withinFamily, selectionSet, layout]);

  const hoverControl = hoverId && layout.controls.some((control) => control.id === hoverId)
    ? hoverId
    : null;
  const hoverOwners = useMemo(() => {
    if (!hoverId || hoverControl) return null;
    const owner = layout.roles.find((item) => item.id === hoverId) ?? layout.evidence.find((item) => item.id === hoverId);
    if (!owner) return null;
    if (selectionActive && selectedId && !owner.controlIds.includes(selectedId)) return null;
    return new Set(owner.controlIds);
  }, [hoverId, hoverControl, layout, selectionActive, selectedId]);
  // Hover and family selection share one focus: a family's controls, or the hovered control.
  const focusGate = !roleId && !evidenceOpen && (!withinFamily || observedWorkspace) && !pipelineHover && !pipelineOpen;
  const focusFamily = focusGate ? (observedWorkspace ? withinFamily : null) ?? hoverFamily ?? (hoverControl ? null : selectedFamily) : null;
  const familyLane = focusFamily ? layout.lanes.find((lane) => lane.id === focusFamily) ?? null : null;
  const focusControlId = hoverControl ?? (selectionActive ? selectedId : null);
  const focusControl = focusGate && !familyLane && focusControlId
    ? layout.controls.find((control) => control.id === focusControlId) ?? null
    : null;
  const focusSet = useMemo(
    () => (familyLane ? new Set(familyLane.memberIds) : focusControl ? new Set([focusControl.id]) : null),
    [familyLane, focusControl],
  );
  // Control faces only: the focus plus one hop of catalog links stay at full opacity.
  const litControls = useMemo(() => {
    if (!focusSet) return null;
    if(familyLane && observedWorkspace)return new Set(focusSet);
    const lit = new Set(focusSet);
    for (const edge of pkg.map.edges) {
      if (focusSet.has(edge.fromId)) lit.add(edge.toId);
      if (focusSet.has(edge.toId)) lit.add(edge.fromId);
    }
    return lit;
  }, [focusSet, familyLane, observedWorkspace, pkg]);
  const hoverArcs = relatedOn && !selectionActive && hoverControl != null && !withinFamily && !familyLane;

  const canvasH = observedWorkspace ? Math.ceil(Math.max((layout.bands.at(-1)?.bottom ?? 0)+24,...(showPipeline?pipelineBoxes.map(box=>box.y+box.h+24):[0])))
    : Math.max(stageFillHeight({ ...stage, height: stage.height / mapScale - pipelineLaneH }, layout.width), layout.height, evidenceSpot ? evidenceSpot.bottom + CARD_GAP : 0);
  const selectionDims = selectionActive && !roleId && !evidenceOpen;

  function dim(ids: string[]): boolean {
    if (!emphasis) return false;
    return !ids.some((id) => emphasis.has(id));
  }

  /** Hover or a selected family dims what the focus does not link to. */
  function focusFaded(ids: string[]): boolean {
    return focusSet != null && !ids.some((id) => focusSet.has(id));
  }

  function roleGhost(ids: string[]): boolean {
    if (selectionDims && selectedId) return !ids.includes(selectedId);
    return dim(ids);
  }

  function tipPosition(x:number,y:number) {
    const left=Math.max(8,Math.min(x,window.innerWidth-290)),stageBox=stageRef.current?.getBoundingClientRect();
    const headers=[...layerRef.current?.querySelectorAll<HTMLElement>("[data-family-header]") ?? []].map(el=>el.getBoundingClientRect());
    const candidates=[y,(stageBox?.bottom ?? y)-54,(stageBox?.top ?? y)+8,y+56,y-56].map(top=>Math.max(8,Math.min(top,window.innerHeight-76)));
    const top=candidates.find(top=>!headers.some(box=>left<box.right&&left+280>box.left&&top<box.bottom&&top+48>box.top)) ?? candidates[0];
    return {x:left,y:top};
  }
  function showTip(text: string, event: React.MouseEvent, owner: string | null = null) {
    if (tipTimer.current) window.clearTimeout(tipTimer.current);
    const target = event.currentTarget.getBoundingClientRect();
    tipTimer.current = window.setTimeout(() => {
      setTip({...tipPosition(target.left,target.bottom+6),text,owner});
    }, 400);
  }

  /** Family box under the pointer, or null over anything with its own hover. */
  function familyAt(event: React.MouseEvent): string | null {
    const target = event.target;
    const layer = layerRef.current;
    if (!layer || !(target instanceof Element) || target.closest(FAMILY_HOVER_SKIP)) return null;
    const box = layer.getBoundingClientRect();
    const x = (event.clientX - box.left) / mapScale;
    const y = (event.clientY - box.top) / mapScale - pipelineLaneH;
    return layout.lanes.find((lane) => x >= lane.x && x <= lane.x + lane.w && y >= lane.y && y <= lane.y + lane.h)?.id ?? null;
  }

  function trackFamily(event: React.MouseEvent) {
    const layer = layerRef.current;
    if (event.target instanceof Element && event.target.closest("[data-family-header]")) return;
    const next = !roleId && !evidenceOpen && !withinPin ? familyAt(event) : null;
    if (next === hoverFamily) return;
    setHoverFamily(next);
    if (familyTipTimer.current) window.clearTimeout(familyTipTimer.current);
    familyTipTimer.current = null;
    const lane = next ? layout.lanes.find((item) => item.id === next) : null;
    if (!lane || !layer) {
      setTip((current) => (current?.owner?.startsWith("family:") ? emptyFamilyTip() : current));
      return;
    }
    setTip((current) => (current?.owner?.startsWith("family:") ? null : current));
    familyTipTimer.current = window.setTimeout(() => {
      familyTipTimer.current = null;
      const box = layer.getBoundingClientRect();
      setTip({...tipPosition(box.left+lane.x*mapScale,box.top+(lane.y+lane.h+pipelineLaneH)*mapScale+6),text:familyRelatedText(pkg,lane.id),owner:`family:${lane.id}`});
    }, 400);
  }

  function leaveFamily() {
    if (familyTipTimer.current) window.clearTimeout(familyTipTimer.current);
    familyTipTimer.current = null;
    setHoverFamily(null);
  }

  /** Tooltip kept up after the pointer leaves, for a selected family with no links. */
  function emptyFamilyTip(): { x: number; y: number; text: string; owner: string } | null {
    if (!selectedFamily || familyRelatedText(pkg, selectedFamily) !== NO_RELATED) return null;
    const lane = layout.lanes.find((item) => item.id === selectedFamily);
    const layer = layerRef.current;
    if (!lane || !layer) return null;
    const box = layer.getBoundingClientRect();
    return { x: box.left + lane.x * mapScale, y: box.top + (lane.y + lane.h + pipelineLaneH) * mapScale + 6, text: NO_RELATED, owner: "pinned-empty" };
  }

  function hideTip() {
    if (tipTimer.current) window.clearTimeout(tipTimer.current);
    tipTimer.current = null;
    setHoverId(null);
    setTip(emptyFamilyTip());
  }

  const missingOnly = showMissing && !showRoles && !showEvidence;
  const soloLayer = ((showRoles !== showEvidence) && !showMissing && (showRoles || showEvidence)) || missingOnly;

  /** Hover emphasis for one related arc. Selection dims stay; hover only works inside them. */
  function relatedStyle(from: string, to: string, mutual: boolean): { opacity: number; width: number } {
    const rest = RELATED_REST;
    if (familyLane && focusSet) return { opacity: focusSet.has(from) || focusSet.has(to) ? 1 : HOVER_DIM, width: rest };
    if (hoverControl) {
      if (from === hoverControl || to === hoverControl) return { opacity: 1, width: RELATED_HOVER };
      return { opacity: HOVER_DIM, width: rest };
    }
    if (hoverOwners && !hoverOwners.has(from) && !hoverOwners.has(to)) return { opacity: HOVER_DIM, width: rest };
    return { opacity: 1, width: rest };
  }

  const wires = useMemo(() => {
    const list: Wire[] = [];
    const selectedWidth = observedWorkspace && selectedId != null;
    if (showRoles) {
      for (const role of layout.roles) {
        const controls = role.controlIds
          .map((id) => layout.controls.find((control) => control.id === id))
          .filter((control): control is LayoutControl => Boolean(control))
          .sort((a, b) => a.x - b.x);
        const tree = attachments.tree(roleTreeKey(role));
        controls.forEach((control) => {
          const fellows = layout.roles.filter((item) => item.controlIds.includes(control.id));
          const slot = Math.max(0, fellows.findIndex((item) => item.id === role.id));
          const x2 = spread(control.x, control.w, fellows.length, slot, 0.6);
          const stub = observedWorkspace && familyLane?.memberIds.includes(control.id);
          const route = stub ? [{ x: x2, y: control.y - 12 }, { x: x2, y: control.y }] : tree?.get(control.id);
          if (!route) return;
          list.push({
            key: `role-${role.id}-${control.id}`,
            group: stub ? undefined : roleTreeKey(role),
            stroke: stub ? "#d99a00" : undefined,
            markerEnd: stub ? true : undefined,
            d: treePath(route),
            rel: "role",
            from: role.id,
            to: control.id,
            width: selectedWidth ? ATTACHMENT_WIDTH : focusSet?.has(control.id) || hoverId === role.id || hoverId === control.id ? 1.9 : 1.25,
            opacity: focusSet ? (focusSet.has(control.id) ? 0.95 : 0.08)
              : roleId === role.id || selectedId === control.id || hoverId === role.id || hoverId === control.id ? 0.85 : dim([control.id]) ? 0.08 : 0.22,
          });
        });
      }
    }
    if(focusLayout){
      const addSpoke=(spoke:FocusSpoke,prefix:string,width:number,opacity:number)=>{
        if(!spoke.d)return;
        list.push({key:`${prefix}${spoke.id}`,d:spoke.d,rel:"related",from:spoke.from,to:spoke.to,glyph:spoke.glyph,line:"solid",width,opacity,pairs:spoke.count,markerEnd:spoke.glyph!=="reverse",markerStart:spoke.glyph!=="outbound",label:prefix==="family-"&&spoke.label?{...spoke.label,text:String(spoke.count)}:undefined});
      };
      if(relatedOn){
        if(focusLayout.focus.hub&&selectionActive)for(const spoke of focusLayout.spokes)addSpoke(spoke,"",RELATED_REST,hoverControl&&hoverControl!==spoke.to&&hoverControl!==spoke.from?HOVER_DIM:1);
        else if(hoverControl&&!selectionActive)for(const spoke of focusLayout.relatedFrom(hoverControl))addSpoke(spoke,"hover-",RELATED_HOVER,1);
        else if(!selectionActive)for(const spoke of focusLayout.spokes)addSpoke(spoke,"family-",Math.min(7,1.8+spoke.count*.35),1);
      }
      for(const box of focusLayout.evidence){
        if(box.pipe&&!showPipeline)continue;
        const whole=box.pipe?(pipelineHover===box.title||(pipelineOpen??pipelineArtifact)===box.title):hoverId===box.id||evidenceOpen===evidenceKey(box);
        const controls=focusLayout.controls.filter(c=>box.controlIds.includes(c.id)&&(whole||evidenceLinesVisible(box.pipe?box.title:box.id,[c.id],{hoveredEvidence:hoverId,selectedEvidence:null,hoveredControl:hoverControl,selectedControl:selectedId,familyControls:familyLane?new Set(familyLane.memberIds):null})));
        const routes=controls.length?focusLayout.evidenceRoutes(box.uuid,whole?undefined:new Set(controls.map(c=>c.id))):undefined;
        for(const control of controls){const d=routes?.get(control.id);if(!d)continue;
          list.push({key:`focus-ev-${box.id}-${control.id}`,group:evidenceTreeKey(box),d,rel:box.provider?"provider":box.pipe?"pipeline-artifact":"evidence",stroke:box.provider?"#7a4fd6":box.pipe?"#168780":undefined,markerEnd:true,from:box.pipe?box.title:box.id,to:control.id,width:box.provider?2.2:box.pipe?1.9:2,opacity:.95});
        }
      }
    }
    if (showEvidence && !observedWorkspace) {
      for (const evidence of layout.evidence.filter((item) => !(item as {pipe?:boolean}).pipe)) {
        const controls = evidence.controlIds
          .map((id) => layout.controls.find((control) => control.id === id))
          .filter((control): control is LayoutControl => Boolean(control))
          .sort((a, b) => a.x - b.x);
        const tree = attachments.tree(evidenceTreeKey(evidence));
        controls.forEach((control) => {
          const route = tree?.get(control.id);
          if (!route || !evidenceLinesVisible(evidence.id,evidence.controlIds,{hoveredEvidence:hoverId,selectedEvidence:evidenceOpen?evidence.id===layout.evidence.find(e=>evidenceKey(e)===evidenceOpen)?.id?evidence.id:null:null,hoveredControl:hoverControl,selectedControl:selectedId,familyControls:familyLane?new Set(familyLane.memberIds):null})) return;
          list.push({
            key: `ev-${evidence.id}-${control.id}`,
            group: evidenceTreeKey(evidence),
            // Planning map (r2 export): evidence runs to the control and the arrowhead lands on the control.
            d: treePath(observedWorkspace ? route : [...route].reverse()),
            rel: "evidence",
            markerEnd: true,
            from: observedWorkspace ? evidence.id : control.id,
            to: observedWorkspace ? control.id : evidence.id,
            width: selectedWidth ? ATTACHMENT_WIDTH : hoverId === evidence.id || hoverId === control.id ? 1.75 : 1.25,
            opacity: focusSet ? (focusSet.has(control.id) ? 0.95 : HOVER_DIM)
              : selectionDims && control.id !== selectedId ? 0.12 : wireOpacity(dim([control.id]), Boolean(emphasis), hoverId, [evidence.id, control.id]),
          });
        });
      }
    }
    if (showMissing && !observedWorkspace) {
      for (const pill of layout.pills) {
        const route = pillRoute(layout, pill);
        if (!route) continue;
        list.push({
          key: `miss-${pill.controlId}-${pill.kind}`,
          d: treePath(route),
          rel: "missing",
          from: pill.controlId,
          to: pill.kind,
          width: 1.25,
          dash: "1.2 2.2",
          opacity: focusSet ? (focusSet.has(pill.controlId) ? 0.9 : HOVER_DIM) : dim([pill.controlId]) ? 0.14 : 0.9,
        });
      }
    }
    const drawn = new Set<string>();
    const arcsFor = (id: string, links: NonNullable<typeof selectedLinks>, prefix: string) => {
      let arcs=arcGeometryCache.get(id);
      if(!arcs){arcs=relatedRoutes(layout,id,links,!observedWorkspace,observedWorkspace);arcGeometryCache.set(id,arcs);}
      for (const arc of arcs) {
        const pair = [arc.from, arc.to].sort().join("|");
        if (drawn.has(pair)) continue;
        drawn.add(pair);
        const mutual = arc.glyph === "mutual";
        const style = relatedStyle(arc.from, arc.to, mutual);
        list.push({
          key: `${prefix}${arc.key}`,
          d: treePath(arc.route),
          rel: "related",
          from: arc.from,
          to: arc.to,
          glyph: arc.glyph,
          line: observedWorkspace || mutual ? "solid" : "dashed",
          width: style.width,
          dash: observedWorkspace || mutual ? undefined : "5 3",
          opacity: style.opacity,
          markerEnd: arc.glyph !== "reverse",
          markerStart: mutual || arc.glyph === "reverse",
        });
      }
    };
    if (!observedWorkspace && drawSelected && (!familyLane || !observedWorkspace) && selectedLinks && selectedId) arcsFor(selectedId, selectedLinks, "");
    if (!observedWorkspace && hoverArcs && hoverControl) arcsFor(hoverControl, directedLinksFor(pkg.map.edges, hoverControl), "hover-");
    if (relatedOn && familyLane && !observedWorkspace) {
      const stats = familyLinkStats(pkg, familyLane.id);
      if (stats.pairs > FAMILY_ARC_LIMIT) {
        const routes = familyRoutes(layout, familyLane.id, [...stats.others.keys()]);
        [...stats.others.keys()].sort().forEach((otherId) => {
          const route = routes.get(otherId);
          if (!route) return;
          const mutual = stats.others.get(otherId) ?? false;
          list.push({
            key: `family-arc-${familyLane.id}-${otherId}`,
            d: treePath(route),
            rel: "related",
            from: familyLane.id,
            to: otherId,
            glyph: mutual ? "mutual" : "outbound",
            line: mutual ? "solid" : "dashed",
            width: RELATED_REST,
            dash: mutual ? undefined : "5 3",
            opacity: 1,
            markerEnd: true,
            markerStart: mutual,
          });
        });
      } else {
        for (const id of familyLane.memberIds) arcsFor(id, directedLinksFor(pkg.map.edges, id), "family-");
      }
    }
    if (relatedOn && withinFamily && !observedWorkspace) {
      const members = layout.controls.filter((control) => control.family === withinFamily);
      const routes = withinRoutes(layout, withinFamily, (a, b) => Boolean(pairOf(pkg, a, b)));
      for (let i = 0; i < members.length; i += 1) {
        for (let j = i + 1; j < members.length; j += 1) {
          const pair = pairOf(pkg, members[i].id, members[j].id);
          const route = routes.get(`${members[i].id}|${members[j].id}`);
          if (!pair || !route) continue;
          const style = relatedStyle(pair.fromId, pair.toId, pair.mutual);
          list.push({
            key: `within-${members[i].id}-${members[j].id}`,
            d: treePath(route),
            rel: "related",
            from: pair.fromId,
            to: pair.toId,
            glyph: pair.mutual ? "mutual" : "outbound",
            line: pair.mutual ? "solid" : "dashed",
            width: style.width,
            dash: pair.mutual ? undefined : "5 3",
            opacity: style.opacity,
            markerEnd: true,
            markerStart: pair.mutual,
          });
        }
      }
    }
    return list;
    // relatedStyle reads the hover sets listed here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, selectionDims, showRoles, showEvidence, showMissing, relatedOn, mode, drawSelected, selectionActive, selectedLinks, selectedId, hoverId, hoverControl, hoverOwners, hoverArcs, emphasis, withinFamily, familyLane, focusSet, pkg, soloLayer, observedWorkspace, arcGeometryCache, attachments, pipelineEvidence, showPipeline, plannedPipelineBoxes, pipelineControls, pipelineHover, pipelineOpen, pipelineArtifact, focusLayout]);

  // Scroll positioning is transient: update the family perimeter without repainting every control card.
  const syncFamilyViewport=useCallback(()=>{
    const node=stageRef.current,layer=layerRef.current;if(!node||!layer)return;
    const viewport={left:(node.scrollLeft-zoom.x)/mapScale,top:(node.scrollTop-zoom.y)/mapScale-pipelineLaneH,width:node.clientWidth/mapScale,height:node.clientHeight/mapScale};
    for(const lane of layout.lanes){
      const view=familyViewport(lane,viewport),id=CSS.escape(lane.id);
      const header=layer.querySelector<HTMLElement>(`[data-family-header="${id}"]`);
      if(header){header.style.top='0px';header.style.paddingLeft=`${Math.max(12,viewport.left-lane.x+12)}px`;header.style.borderTopStyle=view.cutTop?'dashed':'solid';delete header.dataset.pinned;}
      const cuts=layer.querySelector<SVGGElement>(`[data-family-continuation="${id}"]`);
      if(!cuts)continue;
      const inset=1/mapScale;
      const edges={top:{show:view.cutTop,d:`M${view.left} ${view.top+inset} L${view.right} ${view.top+inset}`},bottom:{show:view.cutBottom,d:`M${view.left} ${view.bottom-inset} L${view.right} ${view.bottom-inset}`},left:{show:view.cutLeft,d:`M${view.left+inset} ${view.top} L${view.left+inset} ${view.bottom}`},right:{show:view.cutRight,d:`M${view.right-inset} ${view.top} L${view.right-inset} ${view.bottom}`}};
      for(const [edge,value] of Object.entries(edges)){const path=cuts.querySelector<SVGPathElement>(`[data-cut="${edge}"]`);if(path){path.setAttribute('d',value.d);path.style.display=view.visible&&value.show?'':'none';}}
    }
  },[layout,mapScale,pipelineLaneH,zoom.x,zoom.y]);
  useLayoutEffect(()=>{
    const node=stageRef.current;if(!node)return;syncFamilyViewport();
    node.addEventListener('scroll',syncFamilyViewport,{passive:true});
    return()=>node.removeEventListener('scroll',syncFamilyViewport);
  },[syncFamilyViewport,stage.width,stage.height,level2,evidenceFocusId]);

  useLayoutEffect(()=>{
    // The planning map reveals the selection with its lines instead (auto fit below).
    if(observedWorkspace||level2||evidenceFocusId||!selectedId||roleId||evidenceOpen||pipelineOpen)return;
    const node=stageRef.current,control=layout.controls.find(item=>item.id===selectedId);
    if(!node||!control)return;
    const lane=layout.lanes.find(item=>item.id===control.family);
    const headerSpace=lane?(lane.headerH+24)*mapScale:0;
    const top=(control.y+pipelineLaneH)*mapScale,bottom=top+control.h*mapScale;
    const familyTop=lane?(lane.y+pipelineLaneH)*mapScale:top;
    // Show the actual family top when it fits with the selected control; otherwise pin it.
    if(bottom-familyTop<=node.clientHeight-16) {
      if(familyTop<node.scrollTop||bottom>node.scrollTop+node.clientHeight-8)node.scrollTop=Math.max(0,Math.min(familyTop,bottom-node.clientHeight+8));
    }else if(top<node.scrollTop+headerSpace+8)node.scrollTop=Math.max(0,top-headerSpace-8);
    else if(bottom>node.scrollTop+node.clientHeight-8)node.scrollTop=bottom-node.clientHeight+8;
    if(control.x*mapScale<node.scrollLeft+8)node.scrollLeft=Math.max(0,control.x*mapScale-8);
    else if((control.x+control.w)*mapScale>node.scrollLeft+node.clientWidth-8)node.scrollLeft=(control.x+control.w)*mapScale-node.clientWidth+8;
    syncFamilyViewport();
  },[layout,selectedId,observedWorkspace,pipelineLaneH,roleId,evidenceOpen,pipelineOpen,mapScale,syncFamilyViewport,level2,evidenceFocusId]);

  /** Item c: the drawn lines, their arrowheads and the boxes they reach, in map units.
   * With `ids` only the lines touching those controls count, plus every card they end on. */
  const contentBox=useCallback((ids?:ReadonlySet<string>,pad?:number):MapBox|null=>{
    const boxes:MapBox[]=[];const ends=new Set<string>(ids??[]);
    for(const path of wiresRef.current?.querySelectorAll<SVGPathElement>("path[data-rel]")??[]){
      const from=path.dataset.from??"",to=path.dataset.to??"";
      if(ids&&!ids.has(from)&&!ids.has(to))continue;
      ends.add(from);ends.add(to);
      try{const b=path.getBBox();boxes.push({x:b.x,y:b.y,w:b.width,h:b.height});}catch{/* not rendered */}
    }
    const cards=[...layout.controls,...layout.evidence.filter(e=>observedWorkspace||showEvidence||(e as {pipe?:boolean}).pipe)];
    for(const card of cards)if(!ids||ends.has(card.id)||ends.has((card as {title?:string}).title??""))boxes.push({x:card.x,y:card.y,w:card.w,h:card.h});
    if(!ids)for(const lane of layout.lanes)boxes.push({x:lane.x,y:lane.y,w:lane.w,h:lane.h});
    return unionBox(boxes,pad??arrowUnits(10)+2);
  },[layout,observedWorkspace,showEvidence,mapScale]); // eslint-disable-line react-hooks/exhaustive-deps
  const mapViewport=()=>({width:stage.width-(sidePanelOpen?SIDE_PANEL_ROOM:0),height:stage.height});
  function fitAll(){
    if(focusLayout){const node=stageRef.current;if(node){node.scrollTop=0;node.scrollLeft=0;}setZoom(focusFit());return;}
    const box=observedWorkspace?contentBox():null;
    if(!box){setZoom(fitMap({width:layout.width*autoScale,height:canvasH*autoScale},mapViewport()));return;}
    const node=stageRef.current;if(node){node.scrollTop=0;node.scrollLeft=0;}
    setZoom(fitBox(box,autoScale,mapViewport()));
  }
  // Fit all content on every focus, layer, file, panel and viewport change.
  // Two passes reserve 12 screen pixels for arrowheads at the resulting scale.
  function focusFit(){const box=contentBox(undefined,0);if(!box)return {scale:1,x:0,y:0};const first=fitBox(box,autoScale,mapViewport());return fitBox(contentBox(undefined,12/Math.max(.05,autoScale*first.scale))??box,autoScale,mapViewport());}
  useLayoutEffect(()=>{
    if(!focusLayout||level2||evidenceFocusId)return;
    const key=`${focusLayout.focus.family}|${focusLayout.focus.hub}|${stage.width}|${stage.height}|${sidePanelOpen}|${showPipeline}|${showEvidence}|${showSuggested}|${showMissing}|${showUntouched}|${visiblePipelineFiles.join(",")}|${relatedOn}|${layout.controls.map(c=>c.id).join(",")}`;
    if(autoFitKey.current===key)return;
    const node=stageRef.current;if(!node)return;autoFitKey.current=key;node.scrollTop=0;node.scrollLeft=0;setZoom(focusFit());
  });

  useLayoutEffect(() => {
    const node = cardRef.current;
    if (!node || !cardKind) return;
    const body = node.querySelector<HTMLElement>(".pmap-card-body");
    const natural = node.getBoundingClientRect().height / mapScale + (body ? body.scrollHeight - body.clientHeight : 0);
    const next = Math.ceil(natural);
    setCardH((current) => (current === next ? current : next));
  }, [cardKind, roleId, evidenceOpen, pipelineOpen, pkg, mapScale]);

  useLayoutEffect(() => {
    const node = stageRef.current;
    if (!node || !evidenceSpot || !cardH) return;
    const bottom = (evidenceSpot.bottom + CARD_GAP + pipelineLaneH) * mapScale;
    const top = (evidenceSpot.top - CARD_GAP + pipelineLaneH) * mapScale;
    if (bottom > node.scrollTop + node.clientHeight) node.scrollTop = bottom - node.clientHeight;
    else if (top < node.scrollTop) node.scrollTop = Math.max(0, top);
  }, [evidenceSpot?.top, evidenceSpot?.bottom, cardH, canvasH, pipelineLaneH, mapScale]); // eslint-disable-line react-hooks/exhaustive-deps

  function openEvidenceNow(id: string, node?:typeof baseLayout.evidence[number]) {
    if(observedWorkspace && onOpenEvidenceFocus){const evidence=node??baseLayout.evidence.find(item=>item.id===id);if(evidence)onInspectNode?.({kind:"evidence",id:evidence.id,uuid:evidence.uuid,title:evidence.title,displayId:evidence.displayId,controlIds:evidence.controlIds});onOpenEvidenceFocus(id);return;}
    if (evidenceTimer.current) window.clearTimeout(evidenceTimer.current);
    evidenceTimer.current = null;
    cancelControlSelect();
    onClearSelection?.();
    setRoleId(null);
    setEvidenceOpen(null);
    evidenceOrigin.current = null;
    setEvidenceFocusId(id);
  }

  function leaveEvidenceFocus() {
    const origin = evidenceOrigin.current;
    evidenceOrigin.current = null;
    setEvidenceFocusId(null);
    if (origin) {
      setEvidenceOpen(null);
      if (onOpenControlFocus) onOpenControlFocus(origin.controlId, origin.itemId);
      else onEnterFocus(origin.controlId);
    } else {
      const evidence = baseLayout.evidence.find((item) => item.id === evidenceFocusId);
      setEvidenceOpen(evidence ? evidenceKey(evidence) : null);
    }
  }

  function openControlFocus(id: string) {
    cancelControlSelect();
    onEnterFocus(id);
  }

  function cancelControlSelect() {
    if(selectTimer.current)window.clearTimeout(selectTimer.current);
    selectTimer.current=null;pendingControlSelect.current=null;
  }
  function commitControlSelect() {
    const id=pendingControlSelect.current;cancelControlSelect();
    if(id)onSelect(id);
  }
  function queueControlSelect(id:string) {
    cancelControlSelect();
    if(id===selectedId){onSelect(id);return;}
    // Delay only a new selection so double-click can enter focus before cards move.
    // A newer explicit mode/Related action must settle this choice before its own action.
    pendingControlSelect.current=id;
    selectTimer.current=window.setTimeout(commitControlSelect,100);
  }

  function closeCards(): boolean {
    const open = Boolean(roleId || evidenceOpen || pipelineOpen || withinPin);
    if(open)onInspectNode?.(null);
    setRoleId(null);
    setEvidenceOpen(null);
    setPipelineOpen(null);
    setWithinPin(null);
    setWithinHover(null);
    return open;
  }

  const focused = pkg.controls.find((control) => control.id === selectedId) ?? null;

  if (level2 && focused) {
    return (
      <div className="pmap pmap-focus" data-testid="package-map">
        <ControlFocus
          pkg={pkg}
          pipelineEvidence={pipelineEvidence}
          control={focused}
          selectedItemId={selectedItemId}
          onSelectItem={onSelectItem}
          onLeaveFocus={onLeaveFocus}
          onOpenMappedControl={(id) => onOpenControlFocus?.(id, null)}
          onOpenEvidence={(id) => {
            evidenceOrigin.current = { controlId: focused.id, itemId: selectedItemId };
            onLeaveFocus();
            onClearSelection?.();
            setEvidenceFocusId(id);
          }}
        />
      </div>
    );
  }

  if (evidenceFocusId) {
    return (
      <div className="pmap pmap-focus" data-testid="package-map">
        <EvidenceFocus
          pkg={pkg}
          evidenceId={evidenceFocusId}
          returnControlId={evidenceOrigin.current?.controlId}
          onLeave={leaveEvidenceFocus}
          onOpenControl={(controlId, itemId) => {
            evidenceOrigin.current = null;
            setEvidenceFocusId(null);
            onOpenControlFocus?.(controlId, itemId);
          }}
        />
      </div>
    );
  }

  function openFamily(id:string) {
    cancelControlSelect();
    const next=selectedFamily === id ? null : id;
    onClearSelection?.();setSelectedFamily(next);onSelectFamily?.(next);setMode("family");
  }
  function changeMode(next: Mode) {
    commitControlSelect();
    previousMode.current = next;
    setMode(next);
    // In the planning map, a mode switch is an explicit relationship focus.
    // Clear artifact/card overrides, but retain the selected control for switching back.
    setPipelineHover(null);
    setPipelineOpen(null);
    onSelectPipelineArtifact?.(null);
    setRoleId(null);
    setEvidenceOpen(null);
    setWithinPin(null);
    setWithinHover(null);
    setHoverId(null);
    setHoverFamily(null);
    setTip(null);
    setSelectedFamily(next === "family" && onSelectFamily ? pkg.controls.find((control) => control.id === selectedId)?.family ?? selectedFamily : null);
  }

  const modeContext = mode === "selected"
    ? selectedId ? `Control ${selectedId} · individual connections` : "Select a control to trace its connections"
    : selectedFamily ? `Family ${selectedFamily} · all ${layout.controls.filter((control) => control.family === selectedFamily).length} package controls` : selectedId ? `Control ${selectedId} · selected in By family view` : "Select a family to trace its controls";

  return (
    <div className={`pmap${observedWorkspace ? " pmap-round21 pmap-focus-layout" : ""}${releaseCoverage ? " release-highlight" : ""}`} data-testid="package-map" data-layout-engine={observedWorkspace ? "round21" : "package"}>
      {observedWorkspace && <div className="map-title-row"><h2>Package map</h2>{cloudDefaults.length>0&&<span className="pmap-card-sub" title="Planted-gap baseline branch: codex/phase7-cloud-baseline. Point-in-time operator-run collection on Mac; no hosted or continuous scanning.">Planted gaps · Mac collector</span>}{workspaceNotice}</div>}
      <div className="pmap-toolbar">
        {!observedWorkspace && <h2>Package map</h2>}
        <span className="pmap-chip" title={pkg.map.subsetMatch ? "12 of the FedRAMP Moderate controls" : scopeChip(false, pkg.inScopeCount, pkg.catalog.label)}>
          {scopeChip(pkg.map.subsetMatch, pkg.inScopeCount, pkg.catalog.label)}
        </span>
        {snapshotSelector}
        {!observedWorkspace && <p className={`pmap-honesty ${pkg.gate.status === "PASS" ? "pmap-pass" : ""}`} data-testid="map-fail-banner" title={observedWorkspace || releaseCoverage ? "Evidence linked = coverage only. Blank = no evidence linked, not a failure." : undefined}>
          {releaseCoverage ? "Coverage only. Blank: no evidence." : observedWorkspace ? "Linked = coverage only · Blank ≠ failure." : bannerText(pkg)}
        </p>}
        <div className="pmap-toggles">
          <MapOwnerPicker pkg={hasSsp?(ownerFilterPackage??ownerPackage):{...ownerPackage,loaded:false}} value={owner} onChange={setOwner} example={exampleOwners}/>

          {(observedWorkspace || pipelineEvidence) && <LayerButton disabled={!pipelineEvidence} on={Boolean(pipelineEvidence) && showPipeline} onClick={() => setShowPipeline((value) => !value)}>Pipeline</LayerButton>}
          <LayerButton on={showEvidence} onClick={() => setShowEvidence((value) => !value)}>SSP evidence</LayerButton>
          <LayerButton on={showMissing} onClick={() => setShowMissing((value) => !value)}>Missing</LayerButton>
          {observedWorkspace && <LayerButton on={showSuggested} onClick={() => setShowSuggested((value) => !value)}>Suggested</LayerButton>}
          <div className="pmap-modes" role="group" aria-label="Related links">
            <button type="button" className="pmap-related" aria-pressed={relatedOn} onClick={() => setRelatedOn(!relatedOn)}>
              Related
            </button>
            <button type="button" aria-pressed={mode === "family"} onClick={() => changeMode("family")}>By family</button>
            <button type="button" aria-pressed={mode === "selected"} onClick={() => changeMode("selected")}>Selected control</button>
          </div>
        </div>
      </div>
      {!observedWorkspace && workspaceNotice}
      {(observedWorkspace || pipelineEvidence) && coverageSummary}

      {!observedWorkspace&&<span className="map-mode-context" role="status" data-testid="map-mode-context">{modeContext}</span>}
      {(observedWorkspace || pipelineEvidence) && <section className="map-release-focus" aria-label="Pipeline artifact mapping">
        {pipelineEvidence ? <details className="pipeline-file-picker"><summary>Evidence files · {visiblePipelineFiles.length} of {pipelineFiles.length} shown</summary><div>
          <label>Find file<input aria-label="Find evidence file" value={artifactSearch} onChange={(event) => setArtifactSearch(event.target.value)} /></label>
          <div className="pipeline-picker-actions"><button type="button" onClick={() => setVisibleArtifacts(pipelineFiles)}>Show all</button><button type="button" onClick={() => { setVisibleArtifacts([]); setPipelineOpen(null); onSelectPipelineArtifact?.(null); }}>Clear all</button></div>
          <fieldset><legend>Visible evidence files</legend>{pipelineFiles.filter((name) => name.toLowerCase().includes(artifactSearch.toLowerCase())).map((name) => <label key={name}><input type="checkbox" checked={visiblePipelineFiles.includes(name)} onChange={(event) => {
            const checked = event.target.checked;
            setVisibleArtifacts((current) => checked ? [...new Set([...current, name])] : current.filter((item) => item !== name));
            if (!checked && pipelineArtifact === name) onSelectPipelineArtifact?.(null);
            if (!checked && pipelineOpen === name) setPipelineOpen(null);
          }} /><span>{evidenceFiles.find(file=>file.name===name)?.collected?.source.path??name}</span></label>)}</fieldset>
        </div></details> : <button type="button" disabled>Evidence files · 0 of 0 shown</button>}
      </section>}
      <div
        className={`pmap-stage${panMode||zoom.scale>1?" can-pan":""}${panning?" panning":""}`}
        ref={stageRef}
        data-testid="map-stage"

        onPointerDown={event=>{
          pointerTarget.current=event.target;
          // Drag pans from any point of the map (cards, family boxes, empty space) when the map is
          // zoomed in or the Pan tool is on. Clicks still select until the pointer actually moves.
          if(event.button!==0||!(panMode||zoom.scale>1))return;
          if(event.target instanceof Element&&event.target.closest("a,input,select,textarea,.pmap-zoom,[data-map-card]"))return;
          pan.current={x:event.clientX,y:event.clientY,startX:zoom.x,startY:zoom.y,moved:false,pointerId:event.pointerId};
        }}
        onPointerMove={event=>{const gesture=pan.current;if(!gesture||gesture.pointerId!==event.pointerId)return;const dx=event.clientX-gesture.x,dy=event.clientY-gesture.y;if(!gesture.moved){if(Math.hypot(dx,dy)<=4)return;gesture.moved=true;setPanning(true);event.currentTarget.setPointerCapture(event.pointerId);}setZoom(current=>({...current,x:gesture.startX+dx,y:gesture.startY+dy}));}}
        onPointerCancel={()=>{pan.current=null;setPanning(false);}}
        onPointerUp={()=>{suppressClick.current=Boolean(pan.current?.moved);pan.current=null;setPanning(false);}}
        onClickCapture={event=>{if(suppressClick.current){suppressClick.current=false;event.stopPropagation();event.preventDefault();}}}
        onClick={(event) => {
          const target = event.target;
          if (pointerTarget.current !== target) return;
          if (target instanceof Element && target.closest("button, a, input, select, textarea, [data-map-card]")) return;
          const family = familyAt(event);
          const closed = closeCards();
          if (family) {
            onClearSelection?.();
            if (pipelineEvidence) { previousMode.current = "family"; setMode("family"); }
            const next=selectedFamily === family && !closed ? null : family;
            setSelectedFamily(next);onSelectFamily?.(next);
            return;
          }
          if (closed) return;
          setSelectedFamily(null);onSelectFamily?.(null);
          onClearSelection?.();
        }}
        onMouseMove={trackFamily}
        onMouseLeave={() => { leaveFamily(); setTip(emptyFamilyTip()); }}
      >
        <div className="pmap-layer" ref={layerRef} style={{ width: layout.width, height: canvasH + pipelineLaneH, zoom: mapScale, transform:`translate(${zoom.x/mapScale}px,${zoom.y/mapScale}px)`, transformOrigin:"0 0", "--pmap-scale":mapScale } as React.CSSProperties}>
          <div className="pmap-canvas" style={{ top:pipelineLaneH, height:canvasH }}>
            <svg ref={wiresRef} className="pmap-wires" width={layout.width} height={canvasH} viewBox={`0 0 ${layout.width} ${canvasH}`} aria-hidden="true">
              <defs>
                {/* Arrowheads keep one on-screen size at any map scale, so every line visibly ends in one at its target. */}
                <marker id="pmap-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerUnits="userSpaceOnUse" markerWidth={arrowUnits(10)} markerHeight={arrowUnits(10)} orient="auto-start-reverse">
                  <path d="M0 1 L10 5 L0 9 Z" fill="#d99a00" />
                </marker>
                <marker id="pmap-evidence-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerUnits="userSpaceOnUse" markerWidth={arrowUnits(observedWorkspace ? 10 : 8)} markerHeight={arrowUnits(observedWorkspace ? 10 : 8)} orient="auto"><path d="M0 1 L10 5 L0 9 Z" fill="#3b7fc4" /></marker>
                {observedWorkspace
                  ? <marker id="pmap-pipeline-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerUnits="userSpaceOnUse" markerWidth={arrowUnits(10)} markerHeight={arrowUnits(10)} orient="auto"><path d="M0 1 L10 5 L0 9 Z" fill="#168780" /></marker>
                  : <marker id="pmap-pipeline-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 1 L10 5 L0 9 Z" fill="#168780" /></marker>}
                <marker id="pmap-provider-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerUnits="userSpaceOnUse" markerWidth={arrowUnits(10)} markerHeight={arrowUnits(10)} orient="auto"><path d="M0 1 L10 5 L0 9 Z" fill="#7a4fd6"/></marker>
              </defs>
              <g>
              {layout.lanes.map((lane) => {
                const outlined = observedWorkspace ? withinFamily === lane.id : (selectedId && lane.memberIds.includes(selectedId)) || withinFamily === lane.id;
                const hovered = observedWorkspace ? hoverFamily === lane.id || withinHover === lane.id : familyLane?.id === lane.id;
                return (
                  <rect
                    key={lane.id}
                    data-family-box={lane.id}
                    data-focus={focusLayout?.lanes.find(l=>l.id===lane.id)?.focus}
                    data-linked={releaseCoverage ? linkedByFamily.get(lane.id) : undefined}
                    data-proposed={proposedByFamily.get(lane.id)}
                    data-hover={hovered ? "true" : undefined}
                    data-selected={selectedFamily === lane.id ? "true" : undefined}
                    x={lane.x + 0.5}
                    y={lane.y + 0.5}
                    width={lane.w - 1}
                    height={lane.h - 1}
                    rx={8}
                    fill="#f5f3fe"
                    opacity={focusLayout?.lanes.find(l=>l.id===lane.id)?.focus==="far"?.6:1}
                    stroke={observedWorkspace ? outlined || hovered || focusFamily===lane.id ? "#b9aefc" : "#e6e1ff" : hovered ? "#1a1733" : outlined ? "#b9aefc" : "#e6e1ff"}
                    strokeWidth={outlined && !hovered ? 1.5 : 1}
                  />
                );
              })}
              {layout.lanes.map(lane=><g key={`cuts-${lane.id}`} data-family-continuation={lane.id} fill="none" stroke="#b9aefc" strokeWidth={1.5/mapScale} strokeDasharray={`${5/mapScale} ${4/mapScale}`}>
                {['top','bottom','left','right'].map(edge=><path key={edge} data-cut={edge} d="" style={{display:'none'}}/>)}
              </g>)}
              {wires.filter((wire) => wire.rel === "family-bundle").map((wire) => (
                <WirePath key={wire.key} wire={wire} />
              ))}

              </g>
              <g className={focusLayout?"pmap-focus-lines":undefined} key={focusLayout?`${focusLayout.focus.family}|${focusLayout.focus.hub}|${showEvidence}|${showPipeline}|${showSuggested}|${visiblePipelineFiles.join(",")}`:undefined}>
              <WireGroups wires={wires.filter((wire) => wire.rel === "role")} />
              <WireGroups wires={wires.filter((wire) => wire.rel !== "family-bundle" && wire.rel !== "related" && wire.rel !== "role")} />
              {wires.filter((wire) => wire.rel === "related").map((wire) => (
                <WirePath key={wire.key} wire={wire} />
              ))}
              {wires.filter(w=>w.label).map(w=><g key={`count-${w.key}`} className="pmap-spoke-count" transform={`translate(${w.label!.x},${w.label!.y})`}><circle cx={0} cy={0} r={13} fill="#fff" stroke="#d99a00" strokeWidth={2}/><text textAnchor="middle" y={4.5} fill="#6e4e00" fontSize={12} fontWeight={800}>{w.label!.text}</text></g>)}
              {selectedId && layout.controls.filter((control) => control.id === selectedId).map((control) => (
                <rect
                  key={`halo-${control.id}`}
                  data-halo={control.id}
                  x={control.x - 5}
                  y={control.y - 5}
                  width={control.w + 10}
                  height={control.h + 10}
                  rx={13}
                  fill="#e6e1ff"
                />
              ))}
              </g>
            </svg>
            <div className="pmap-lower">
            {layout.lanes.map((lane) => {return (
              <div key={lane.id} className="pmap-family-header-track" data-focus={focusLayout?.lanes.find(l=>l.id===lane.id)?.focus} style={{position:"absolute",left:lane.x,top:lane.y,width:lane.w,height:lane.h,pointerEvents:"none",zIndex:5}}>
              <div
                className="pmap-lane-label"
                data-family-header={lane.id}
                title={lane.title}
                onDragStart={event=>event.preventDefault()}
                onMouseEnter={() => setHoverFamily(lane.id)}
                onMouseLeave={leaveFamily}
                style={{ position:"absolute", top:0, left:0, width:lane.w, height:lane.headerH+24, paddingLeft:12, borderTopStyle:"solid", "--cw":`${Math.max(40,familyCardSize(lane)-6)}px`, "--fam-code":`${FAMILY_CODE_PX}px`, "--fam-title":`${FAMILY_TITLE_PX}px`, "--fam-count":`${FAMILY_COUNT_PX}px` } as React.CSSProperties}
              >
                <div className="pmap-lane-top">
                  {onSelectFamily ? <button type="button" className="pmap-family-open" aria-label={`Open ${lane.id} family details`} onClick={event=>{event.stopPropagation();openFamily(lane.id);}}>{lane.id}</button> : <strong>{lane.id}</strong>}
                  {<span className={`${lane.open > 0 ? "bad " : ""}pmap-of-total`}>{`${lane.memberIds.filter(id=>touchedIds.has(id)).length} of ${pkg.map.families.find(f=>f.id===lane.id)?.moderateBase??lane.memberIds.length}`}</span>}
                </div>
                {observedWorkspace ? <em className="pmap-fam-title">{lane.title}</em> : <>
                <em>{lane.titleLines[0]}</em>
                {lane.titleLines[1] ? <em>{lane.titleLines[1]}</em> : null}</>}
                <button
                  type="button"
                  className="pmap-within sr-only"
                  title={lane.baselineText}
                  aria-label={`${lane.id} ${lane.within} within`}
                  onClick={() => {if(onSelectFamily)openFamily(lane.id);else setWithinPin(current=>current === lane.id ? null : lane.id);}}
                  onMouseEnter={() => setWithinHover(lane.id)}
                  onMouseLeave={() => setWithinHover(null)}
                >
                  {releaseCoverage ? <span title={`${releaseCoverage.controls.filter(c=>c.family===lane.id && c.rollupState==="recorded").length} linked · ${releaseCoverage.controls.filter(c=>c.family===lane.id && c.rollupState==="blank").length} blank · ${pkg.controls.filter(c=>c.family===lane.id && releaseCoverage.controls.some(r=>r.id===c.id && r.rollupState==="recorded")).length} on map`}>{releaseCoverage.controls.filter(c=>c.family===lane.id && c.rollupState==="recorded").length} linked</span> : observedWorkspace ? <span>{lane.memberIds.length} controls</span> : <><span>{lane.baselineLines[0]}</span>{lane.baselineLines[1] ? <span>{lane.baselineLines[1]}</span> : null}</>}
                  {(proposedByFamily.get(lane.id) ?? 0) > 0 && <span data-family-proposals={lane.id} title="Controls with pending artifact mapping proposals; suggestions add no linked evidence.">{proposedByFamily.get(lane.id)} proposed</span>}
                </button>
              </div></div>
            );})}
            {layout.controls.map((control) => {
              const fixedRelease = releaseBundle && fixedByRelease.has(control.id) ? releaseBundle : undefined;
              const Tile = fixedRelease ? "a" : "button";
              const selected = selectedId === control.id;
              const isHub=Boolean(focusLayout?.controls.find(c=>c.id===control.id)?.hub);
              const untouched=observedWorkspace&&showUntouched&&!touchedIds.has(control.id)&&!isHub;
              const provider=providerExtent(sourceForCoverage(control.id));
              const far=focusLayout?.lanes.find(l=>l.id===control.family)?.focus==="far";
              const ownerFaded=!ownerMatches(ownerFilterPackage??ownerPackage,control.id,owner);
              const faded = observedWorkspace ? familyLane ? !familyLane.memberIds.includes(control.id) : selectedFamily ? focusFaded([control.id]) : selectionActive ? dim([control.id]) : !focusSet && dim([control.id]) : selectionActive && !familyLane ? dim([control.id]) : !focusSet && dim([control.id]);
              const hoverFaded = litControls != null && !litControls.has(control.id);
              const [a, b] = observedWorkspace ? compactFaceLines(control.id,control.title,control.w) : faceLines(control.id,control.title);
              const {source,coverage}=controlFaces.get(control.id)!;
              const face = source.rollupState === "recorded" ? "● linked" : observedWorkspace ? "" : controlFaceStatus(source);
              const rollup = source.rollupState;
              const releaseControl=releaseControls.get(control.id);
              const linked=releaseControl?.rollupState==="recorded"?releaseControl:undefined;
              const proposals = snapshotProposalCounts?.get(control.id) ?? proposalCounts?.get(control.id) ?? 0;
              const pendingProposals=proposals>0 && !(recordedControlIds?.has(control.id) ?? source.rollupState==="recorded");
              const proposalPill=proposalPillIds.has(control.id);
              const proposalFace=`${proposals} proposed`;
              const proposalFont=Math.min(7,(control.w-8)/manropeWidth(proposalFace,1,800));
              return (
                <Tile
                  key={control.id}
                  type={fixedRelease ? undefined : "button"}
                  href={fixedRelease ? releaseEvidenceHref(fixedRelease) : undefined}
                  data-release-fixed={fixedRelease ? "true" : undefined}
                  data-release-id={fixedRelease?.releaseId}
                  className={`pmap-control${isHub?" pmap-focus-hub":""}${provider?` pmap-provider-${provider}`:""}${untouched?" pmap-untouched":""}${showMissing&&hasSsp&&missingFieldsInSsp(ownerPackage,control.id).length?" pmap-missing-ring has-missing":""} l1-card ${reviewControlIds?.has(control.id) ? "needs-review" : ""} ${observedWorkspace || rollup ? "" : control.complete ? "ok" : "open"} ${selected ? "selected" : ""} ${source.rollupState === "recorded" || linked ? "pipeline-linked" : ""} ${activeArtifact && activeArtifactControls.includes(control.id) ? "pipeline-linked" : ""} ${faded ? "l1-dim" : ""} ${hoverFaded ? "hover-dim" : ""}`}
                  data-control-id={control.id}
                  data-focus-hub={isHub?"true":undefined}
                  data-provider-coverage={provider??undefined}
                  data-tile={untouched ? "true" : undefined}
                  data-hover={hoverId === control.id ? "true" : undefined}
                  data-related-control={selectedId && selectedId !== control.id && selectionSet?.has(control.id) ? control.id : undefined}
                  data-family={control.family}
                  data-needs-review={reviewControlIds?.has(control.id) ? "true" : undefined}
                  data-rollup={rollup}
                  data-map-style={observedWorkspace ? "planning" : "package"}
                  data-proposed={proposals}
                  data-proposal-control={pendingProposals ? control.id : undefined}
                  data-pending-proposals={pendingProposals ? "true" : undefined}
                  data-proposal-pill={proposalPill ? "true" : undefined}
                  data-release-linked={linked ? "true" : undefined}
                  style={{ left: control.x, top: control.y, width: control.w, height: control.h, "--pmap-card-size":`${control.w}px`, opacity: ownerFaded || faded || (hoverFaded && !(observedWorkspace && selectionActive)) ? CARD_DIM : far?CARD_DIM:1 } as React.CSSProperties}
                  aria-pressed={fixedRelease ? undefined : selected}
                  aria-description={fixedRelease ? "Collected release retest passed; human closure review required. Open release " + fixedRelease.releaseId : hasSsp&&showMissing&&missingFieldsInSsp(ownerPackage,control.id).length?`Missing in SSP: ${missingFieldsInSsp(ownerPackage,control.id).join(", ")}`:undefined}
                  aria-label={`${control.id} ${control.title}, ${rollup === "blank" ? "blank" : rollup === "recorded" ? "recorded" : control.complete ? "complete" : "incomplete"}${proposals ? `, ${proposals} proposed mappings, not accepted` : ""}`}
                  title={fixedRelease ? "Verified fixes in release " + fixedRelease.releaseId + "; human closure review required. Open release." : linked ? `${control.title} · latest result #${linked.rollupReleaseId} · coverage only` : source.rollupState === "recorded" ? `${control.title} · latest result #${source.rollupReleaseId} · coverage only` : control.title}
                  onKeyDown={(event) => {
                    if (fixedRelease || event.key !== "Enter") return;
                    event.preventDefault();
                    onEnterFocus(control.id);
                  }}
                  onMouseEnter={(event) => { setHoverId(control.id); showTip(controlRelatedText(pkg, control.id), event); }}
                  onMouseLeave={hideTip}
                  onClick={(event) => {
                    event.stopPropagation();
                    if (fixedRelease) return;
                    const dot=event.target instanceof Element?event.target.closest<HTMLElement>('[data-control-dot]'):null;
                    setSelectedDot(dot?`${control.id}:${dot.dataset.controlDot}`:null);
                    if (event.detail > 1) {
                      openControlFocus(control.id);
                      return;
                    }
                    if (mode !== "selected") previousMode.current = mode;
                    setMode("selected");
                    setRoleId(null);
                    setEvidenceOpen(null);
                    setPipelineOpen(null);
                    setWithinPin(null);setWithinHover(null);setSelectedFamily(null);setHoverFamily(null);
                    onSelectPipelineArtifact?.(null);
                    queueControlSelect(control.id);
                  }}
                  onDoubleClick={(event) => {
                    event.stopPropagation();
                    if (!fixedRelease) openControlFocus(control.id);
                  }}
                >
                  <MapControlFace untouched={untouched && !fixedRelease} id={control.id} a={a} b={b} proposalPill={proposalPill} coverage={coverage} selectedDot={selected?selectedDot:null} linked={Boolean(linked)}
                    reviewText={planStateLabels?.get(control.id) ?? (reviewControlIds?.has(control.id)?(observedWorkspace&&control.w<45?"Review":"Needs review"):null)} reviewTitle={planStateLabels?.get(control.id)??"Needs review"} reviewState={planStateLabels?.get(control.id)?"closed":"open"}
                    statusClass={observedWorkspace||rollup?"pmap-status-line":control.complete?"good mark-ok pmap-status-line":"bad pmap-status-line"} statusText={fixedRelease ? "retest passed" : pendingProposals?proposalFace:face} statusTitle={pendingProposals?`${proposals} proposed artifact mappings, not accepted`:undefined} proposalFont={proposalFont}/>

                </Tile>
              );
            })}
            {!observedWorkspace && showMissing && layout.pills.map((pill) => (
              <button
                key={`${pill.controlId}-${pill.kind}`}
                type="button"
                className="pmap-pill"
                data-flag-for={pill.controlId}
                data-kind={pill.kind}
                style={{ left: pill.x, top: pill.y, width: pill.w, opacity: focusFaded([pill.controlId]) ? HOVER_DIM : undefined }}
                onClick={(event) => event.stopPropagation()}
              >
                {pill.label}
              </button>
            ))}
            {focusLayout?.evidence.filter(e=>e.provider).map(box=><button key={box.id} type="button" className={`pmap-evidence pmap-provider-box${focusFaded(box.controlIds)?" hover-dim":""}`} data-provider-id={box.id} data-controls={box.controlIds.join(" ")} style={{left:box.x,top:box.y,width:box.w,height:box.h,opacity:focusFaded(box.controlIds)?HOVER_DIM:1}} onMouseEnter={()=>setHoverId(box.id)} onMouseLeave={hideTip} onClick={event=>{event.stopPropagation();setHoverId(box.id);}}><span className="mono eid">LEVERAGED{box.detail==="EXAMPLE DATA"?" · EXAMPLE":""}</span><strong>{box.title}</strong><em>{box.subtitle}</em></button>)}
            {showEvidence && layout.evidence.filter((evidence)=>!(evidence as {pipe?:boolean}).pipe&&!(evidence as {provider?:boolean}).provider).map((evidence) => {
              const ghost = !focusSet && roleGhost(evidence.controlIds);
              return (
              <button
                key={`${evidenceKey(evidence)}:${evidence.band}`}
                type="button"
                className={`pmap-evidence ${ghost ? "dim" : ""} ${focusFaded(evidence.controlIds) ? "hover-dim" : ""} ${evidenceOpen === evidenceKey(evidence) ? "active" : ""}`}
                style={{ left: evidence.x, top: evidence.y, width: evidence.w, height: 48, opacity: ghost ? 0.12 : focusFaded(evidence.controlIds) ? HOVER_DIM : 1 }}
                data-evidence-id={evidence.id}
                data-evidence-key={`${evidenceKey(evidence)}:${evidence.band}`}
                data-row={evidence.row}
                data-host={evidence.host}
                data-placement={evidence.placement}
                data-controls={evidence.controlIds.join(" ")}
                data-displaced={evidence.displaced ? "true" : "false"}
                aria-expanded={evidenceOpen === evidenceKey(evidence)}
                title={`${evidence.title}. ${evidence.detail}`}
                onMouseEnter={(event) => { setHoverId(evidence.id); showTip(evidence.title, event, `evidence:${evidenceKey(evidence)}`); }}
                onMouseLeave={hideTip}
                onClick={(event) => {
                  event.stopPropagation();
                  if (event.detail > 1) {
                    openEvidenceNow(evidence.id,evidence);
                    return;
                  }
                  if (evidenceTimer.current) window.clearTimeout(evidenceTimer.current);
                  const key = evidenceKey(evidence);
                  evidenceTimer.current = window.setTimeout(() => {
                    evidenceTimer.current = null;
                    setRoleId(null);
                    setPipelineOpen(null);
                    onSelectPipelineArtifact?.(null);
                    setEvidenceOpen(key);
                    onInspectNode?.({kind:"evidence",id:evidence.id,uuid:evidence.uuid,title:evidence.title,displayId:evidence.displayId,controlIds:evidence.controlIds});
                  }, 400);
                }}
                onDoubleClick={(event) => {
                  event.stopPropagation();
                  openEvidenceNow(evidence.id,evidence);
                }}
              >
                <span className="mono eid">{evidence.displayId ?? evidence.id}</span>
                <strong>{evidenceDisplayTitle(evidence.title)}</strong>
                <em>{evidence.subtitle}</em>
              </button>
              );
            })}
            </div>
            {showRoles && layout.roles.map((role) => {
              const ghost = !focusSet && roleGhost(role.controlIds);
              return (
              <button
                key={role.id}
                type="button"
                className={`pmap-role ${ghost ? "dim" : ""} ${focusFaded(role.controlIds) ? "hover-dim" : ""} ${roleId === role.id ? "active" : ""}`}
                data-role-id={role.id}
                style={{ left: role.x, top: role.y, width: role.w, height: ROLE_H, opacity: ghost ? 0.12 : focusFaded(role.controlIds) ? HOVER_DIM : 1 }}
                aria-label={`${role.label}. ${role.title}`}
                aria-expanded={roleId === role.id}
                title={role.title}
                onMouseEnter={(event) => { setHoverId(role.id); showTip(role.title, event, `role:${role.id}`); }}
                onMouseLeave={hideTip}
                onClick={(event) => {
                  event.stopPropagation();
                  setEvidenceOpen(null);
                  setPipelineOpen(null);
                  onSelectPipelineArtifact?.(null);
                  const next=roleId===role.id?null:role.id;
                  setRoleId(next);
                  onInspectNode?.(next?{kind:"role",id:"sourceId" in role?String(role.sourceId):role.id,title:role.title,controlIds:role.controlIds}:null);
                }}
              >
                <strong>{role.label}</strong>
                <span>ROLE · {role.controlIds.length} control{role.controlIds.length === 1 ? "" : "s"}</span>
              </button>
              );
            })}
          </div>
          {pipelineEvidence && showPipeline && <>
            {!observedWorkspace && <>
            <svg className="pmap-pipeline-wires" width={layout.width} height={canvasH + pipelineLaneH} aria-hidden="true">
              {legacyPipelineBoxes.flatMap((box) => layout.controls.filter((control) => pipelineControls.get(box.name)?.includes(control.id)).map((control) => {
                const lane = layout.lanes.find((item) => item.id === control.family)!;
                const right=control.x+control.w/2>=layout.width/2;
                const side=right?1:-1,x=right?box.x+box.w:box.x,y=box.y+box.h/2;
                const column=x+side*4,outside=right?layout.width-7:7;
                const familyGap=observedWorkspace?4:18,controlGap=observedWorkspace?3:16;
                const family=right?lane.x+lane.w+familyGap:lane.x-familyGap;
                const target=right?control.x+control.w+controlGap:control.x-controlGap;
                const edge=right?control.x+control.w:control.x;
                const bridge=pipelineLaneH-8,band=pipelineLaneH+lane.y-20,row=pipelineLaneH+control.y-24,middle=pipelineLaneH+control.y+control.h/2;
                const focused=evidenceLinesVisible(box.name,pipelineControls.get(box.name)??[],{hoveredEvidence:pipelineHover,selectedEvidence:pipelineOpen??pipelineArtifact,hoveredControl:hoverControl,selectedControl:selectedId,familyControls:familyLane?new Set(familyLane.memberIds):null});
                if(!focused)return null;
                const d = `M ${x} ${y} L ${column} ${y} L ${column} ${bridge} L ${outside} ${bridge} L ${outside} ${band} L ${family} ${band} L ${family} ${row} L ${target} ${row} L ${target} ${middle} L ${edge} ${middle}`;
                return <path key={`${box.name}:${control.id}`} data-pipeline-artifact={box.name} data-pipeline-control={control.id} d={d} fill="none" stroke="#168780" strokeWidth={focused ? 1.9 : 1.2} opacity={focused ? .95 : .18} markerEnd="url(#pmap-pipeline-arrow)" />;
              }))}
            </svg>
            </>}
            <div aria-label="Pipeline evidence artifacts">{pipelineBoxes.map((box) => {
              const controls = pipelineControls.get(box.name)??[];
              return <button key={box.name} type="button" className={`pmap-evidence pmap-pipeline-artifact${activeArtifact === box.name ? " active" : ""}`} data-map-card data-pipeline-file={box.name} style={{ left:box.x, top:box.y, width:box.w, height:box.h }} aria-expanded={pipelineOpen === box.name}
                onMouseEnter={() => { setPipelineHover(box.name); setHoverFamily(null); }} onMouseLeave={() => setPipelineHover(null)} onFocus={() => setPipelineHover(box.name)} onBlur={() => setPipelineHover(null)}
                onClick={() => { onInspectNode?.(null); setPipelineOpen(box.name); onSelectPipelineArtifact?.(box.name); setSelectedFamily(null); setRoleId(null); setEvidenceOpen(null); }}>
                <span className="mono eid">{evidenceFiles.find(file=>file.name===box.name)?.inventory?"ACCOUNT SCAN":"PIPELINE"}</span><strong>{awsArtifactTitle(evidenceFiles.find(file=>file.name===box.name)?.collected)??box.name}</strong><em>{evidenceFiles.find(file=>file.name===box.name)?.inventory?"Inventory · errors retained":controls.length ? `${controls.length} mapped controls` : "No control mapping reported"}</em>
              </button>;
            })}</div>
          </>}
          {pipelineEvidence && pipelineOpen && pipelineSpot && showPipeline && <MapCard cardRef={cardRef} testId="pipeline-evidence-card" kind="evidence" kicker="Evidence · pipeline artifact" caret="up" caretX={pipelineSpot.caretX} style={{ left:pipelineSpot.left, top:pipelineSpot.top, maxHeight:cardMaxH, visibility:cardH ? undefined : "hidden" }} onClose={() => setPipelineOpen(null)}>
            <PipelineArtifactCardBody pkg={pkg} record={evidenceFiles.find(file=>file.name===pipelineOpen)?.source??pipelineEvidence} name={pipelineOpen} onOpenControl={(id) => { setPipelineOpen(null); onOpenControlFocus?.(id, null); }} />
          </MapCard>}
          {roleSpot && roleId && (
            <MapCard
              cardRef={cardRef}
              testId="role-card"
              kind="role"
              kicker="Role · responsible party"
              caret="up"
              caretX={roleSpot.caretX}
              leader={roleSpot.leader}
              style={{ left: roleSpot.left, top: roleSpot.top + pipelineLaneH, maxHeight: roleSpot.maxHeight ?? cardMaxH, visibility: cardH ? undefined : "hidden" }}
              onClose={() => setRoleId(null)}
            >
              <RoleCardBody pkg={pkg} roleId={roleBox && "sourceId" in roleBox ? String(roleBox.sourceId) : roleId} onOpen={(id) => {
                setRoleId(null);
                onSelect(id);
              }} />
            </MapCard>
          )}
          {evidenceSpot && evidenceBox && (
            <MapCard
              cardRef={cardRef}
              testId="evidence-card"
              kind="evidence"
              kicker={`Evidence · ${evidenceBox.subtitle}`}
              caret="up"
              caretX={evidenceSpot.caretX}
              style={{ left: evidenceSpot.left, top: evidenceSpot.top + pipelineLaneH, visibility: cardH ? undefined : "hidden" }}
              onClose={() => setEvidenceOpen(null)}
            >
              <EvidenceCardBody
                pkg={pkg}
                evidence={evidenceBox}
                onOpen={() => {
                  onClearSelection?.();
                  setEvidenceFocusId(evidenceBox.id);
                }}
                onOpenControl={onSelect}
              />
            </MapCard>
          )}
        </div>
      </div>
      <MapZoomControl panelOpen={sidePanelOpen} panMode={panMode} onPanMode={setPanMode} scale={zoom.scale} onZoom={factor=>setZoom(current=>zoomAt(current,current.scale*factor,{x:stage.width/2,y:stage.height/2}))} onReset={()=>setZoom({scale:1,x:0,y:0})} onFit={fitAll}/>
      {observedWorkspace ? (
        <div className="pmap-legend pmap-legend-r2" aria-label="Map legend">
          {pkg.controls.some(c=>!proposalPillIds.has(c.id)&&c.rollupState==="recorded")&&<R2Swatch kind="linked" label="Linked evidence"/>}
          {proposalPillIds.size>0&&<R2Swatch kind="proposed" label="Suggested files only"/>}
          {layout.controls.some(c=>!proposalPillIds.has(c.id)&&controlFaces.get(c.id)?.source.rollupState!=="recorded")&&<R2Swatch kind="blank" label="No evidence"/>}
          {layout.controls.some(c=>!proposalPillIds.has(c.id))&&<span className="pmap-legend-item">Statement parts<i className="lg-dot linked"/>with evidence<i className="lg-dot addressed"/>no evidence<i className="lg-dot"/>not addressed</span>}
          {showEvidence&&layout.evidence.some(e=>!(e as {pipe?:boolean}).pipe&&!(e as {provider?:boolean}).provider)&&<R2Swatch kind="ssp" label="SSP evidence"/>}
          {showPipeline&&pipelineBoxes.length>0&&<R2Swatch kind="pipe" label="Pipeline artifact"/>}
          {showMissing&&hasSsp&&layout.controls.some(c=>missingFieldsInSsp(ownerPackage,c.id).length)&&<R2Swatch kind="missing" label="Missing in SSP"/>}
          {!(providerLegend?.available??providers.length>0)&&<span className="pmap-legend-item pmap-legend-provider" data-provider-empty>No provider coverage supplied</span>}
          {(providerLegend?.available??providers.length>0)&&<span className="pmap-legend-item pmap-legend-provider">{(providerLegend?.example??providers.some(p=>p.example))&&<b className="pm-example">EXAMPLE DATA</b>}<LineSwatch color="#7a4fd6" label="Provider covers it" direction="outbound"/><i className="pm-hatch all"/>all<i className="pm-hatch part"/>part</span>}
          {wires.some(w=>w.rel==="related"&&w.glyph==="mutual")&&<LineSwatch color="#d99a00" label="⇄ both list each other" direction="mutual"/>}
          {wires.some(w=>w.rel==="related"&&w.glyph==="outbound")&&<LineSwatch color="#d99a00" label="→ listed by selected" direction="outbound"/>}
          {wires.some(w=>w.rel==="related"&&w.glyph==="reverse")&&<LineSwatch color="#d99a00" label="← listed by the other" direction="reverse"/>}
        </div>
      ) : (
      <div className="pmap-legend" aria-label="Map legend">
        <span className="coverage-legend"><i className="linked" /> Addressed + item evidence <i className="addressed" /> Addressed, no item evidence <i className="empty" /> Not addressed · informational</span>
        <Swatch className="family" label="Family" />
        <Swatch className="incomplete" label="Incomplete" />
        <Swatch className="role" label="Role" />
        <Swatch className="evidence" label="Evidence" />
        <i className="pmap-legend-rule" />
        <LineSwatch color="#8f7bff" label="Responsible role" />
        {pipelineEvidence && <LineSwatch color="#168780" label="pipeline artifact → control" />}
        <LineSwatch color="#3b7fc4" label={pipelineEvidence ? "SSP evidence" : "evidence"} />
        <LineSwatch color="#e8264f" label="missing" dash />
        <span className="pmap-legend-item">
          <svg width="22" height="8" aria-hidden="true"><path d="M1 4 H21" fill="none" stroke="#d99a00" strokeWidth="2" strokeLinecap="round" /></svg>
          related links (hover or select a control or family)
        </span>
        {selectedId && (
          <>
            <span className="pmap-legend-item">
              <svg width="22" height="8" aria-hidden="true">
                <defs>
                  <marker id="pmap-legend-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerUnits="userSpaceOnUse" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                    <path d="M0 0.6 L8 4 L0 7.4 Z" fill="#d99a00" />
                  </marker>
                </defs>
                <path d="M1 4 H21" fill="none" stroke="#d99a00" strokeWidth="2" markerEnd="url(#pmap-legend-arrow)" />
              </svg>
              ⇄ both list each other
            </span>
            <span className="pmap-legend-item">
              <svg width="22" height="8" aria-hidden="true"><path d="M1 4 H21" fill="none" stroke="#d99a00" strokeWidth="2" strokeDasharray="5 3" /></svg>
              → one-way related
            </span>
          </>
        )}
        <span className="round21-hidden" />
        <span className="pmap-scope">Controls · {pkg.inScopeCount} in scope</span>
        {pkg.boundaryId ? <span className="pmap-scope">{pkg.boundaryId}</span> : null}
      </div>
      )}
      {tip && (tip.owner == null || tip.owner !== openCardOwner) && <div className="pmap-tip" style={{ left: tip.x, top: tip.y }}>{tip.text}</div>}
    </div>
  );
}

/** Ungrouped wires in order. Wires of one tree with the same opacity share one group that carries the opacity;
 * each path keeps its opacity attribute and paints at full strength inside the group. */
function WireGroups({ wires }: { wires: Wire[] }) {
  const groups = new Map<string, Wire[]>();
  const items: (Wire | string)[] = [];
  for (const wire of wires) {
    if (!wire.group) {
      items.push(wire);
      continue;
    }
    const key = `${wire.group}|${wire.opacity}`;
    if (!groups.has(key)) {
      groups.set(key, []);
      items.push(key);
    }
    groups.get(key)!.push(wire);
  }
  return (
    <>
      {items.map((item) => typeof item === "string" ? (
        <g key={item} data-tree={groups.get(item)![0].group} opacity={groups.get(item)![0].opacity}>
          {groups.get(item)!.map((wire) => <WirePath key={wire.key} wire={wire} grouped />)}
        </g>
      ) : <WirePath key={item.key} wire={item} />)}
    </>
  );
}

function WirePath({ wire, grouped = false }: { wire: Wire; grouped?: boolean }) {
  return (
    <path
      data-rel={wire.rel}
      data-pipeline-artifact={wire.rel === "pipeline-artifact" ? wire.from : undefined}
      data-pipeline-control={wire.rel === "pipeline-artifact" ? wire.to : undefined}
      data-routing={wire.rel === "related" && /C/.test(wire.d) ? "fan" : undefined}
      data-from={wire.from}
      data-to={wire.to}
      data-glyph={wire.glyph}
      data-line={wire.line}
      data-pairs={wire.pairs}
      d={wire.d}
      fill="none"
      stroke={wire.stroke ?? strokeFor(wire.rel)}
      strokeWidth={wire.width}
      strokeDasharray={wire.dash}
      strokeLinecap="round"
      vectorEffect="non-scaling-stroke"
      opacity={wire.opacity}
      style={grouped ? { opacity: 1 } : undefined}
      markerEnd={wire.markerEnd ? wire.rel === "provider" ? "url(#pmap-provider-arrow)" : wire.rel === "evidence" ? "url(#pmap-evidence-arrow)" : wire.rel === "pipeline-artifact" ? "url(#pmap-pipeline-arrow)" : "url(#pmap-arrow)" : undefined}
      markerStart={wire.markerStart ? "url(#pmap-arrow)" : undefined}
    />
  );
}

function bannerText(pkg: PackageState): string {
  if (pkg.gate.status === "FAIL") return "Links from the 800-53 Rev " + (pkg.map.catalogVersion ?? "5.2.0") + " catalog; baseline counts from the FedRAMP Rev5 Moderate profile. FAIL = missing required fields or evidence, not authorization.";
  if (pkg.gate.status === "PASS") return "PASS means required fields and evidence are present. Completeness is not an authorization result.";
  return pkg.map.note;
}

export function GateStatus({ pkg }: { pkg: PackageState }) {
  return (
    <span className="pmap-status" data-testid="completeness-status">
      <strong>{pkg.gate.status}</strong>
      <span>{pkg.gate.label}</span>
      <span className="pmap-status-note">Status only. Not an edge sink.</span>
    </span>
  );
}

function strokeFor(rel: string): string {
  if (rel === "role") return "#8f7bff";
  if (rel === "evidence") return "#3b7fc4";
  if (rel === "missing") return "#e8264f";
  return "#d99a00";
}

function wireOpacity(faded: boolean, emphasizing: boolean, hoverId: string | null, owners: string[]): number {
  if (faded) return 0.14;
  if (!emphasizing && hoverId && !owners.includes(hoverId)) return HOVER_DIM;
  return 0.95;
}



/** Tooltip line for a control: how many controls on the map it relates to, across how many families. */
function controlRelatedText(pkg: PackageState, controlId: string): string {
  const links=directedLinksFor(pkg.map.edges,controlId);
  const peers=new Set([...links.mutual,...links.outbound,...links.reverse].map(l=>l.otherId));
  if (!peers.size) return NO_RELATED;
  const families=new Set([...peers].map(id=>id.split("-")[0]));
  return `${controlId}: related to ${peers.size} control${peers.size === 1 ? "" : "s"} in ${families.size} famil${families.size === 1 ? "y" : "ies"}`;
}

/** Pairs and other families touched by one family's catalog links. */
function familyLinkStats(pkg: PackageState, familyId: string) {
  const familyOf = new Map(pkg.controls.map((control) => [control.id, control.family]));
  const pairs = new Set<string>();
  const within = new Set<string>();
  const others = new Map<string, boolean>();
  for (const edge of pkg.map.edges) {
    const a = familyOf.get(edge.fromId);
    const b = familyOf.get(edge.toId);
    if (!a || !b || edge.fromId === edge.toId || (a !== familyId && b !== familyId)) continue;
    const pair = [edge.fromId, edge.toId].sort().join("|");
    pairs.add(pair);
    if (a === b) {
      within.add(pair);
      continue;
    }
    const other = a === familyId ? b : a;
    others.set(other, (others.get(other) ?? false) || Boolean(edge.mutual));
  }
  return { pairs: pairs.size, within: within.size, others };
}

/** Tooltip line for a family: how many other families its controls relate to, and how many control pairs. */
function familyRelatedText(pkg: PackageState, familyId: string): string {
  const stats = familyLinkStats(pkg, familyId);
  if (stats.pairs === 0) return NO_RELATED;
  const links = `${stats.pairs} link${stats.pairs === 1 ? "" : "s"}`;
  if (stats.others.size === 0) return `${familyId}: ${links}, all within ${familyId}`;
  const inside = stats.within > 0 ? ` (${stats.within} within ${familyId})` : "";
  return `${familyId}: related to ${stats.others.size} famil${stats.others.size === 1 ? "y" : "ies"}, ${links}${inside}`;
}

function pairOf(pkg: PackageState, a: string, b: string) {
  const edges = pkg.map.edges.filter((edge) => (
    (edge.fromId === a && edge.toId === b) || (edge.fromId === b && edge.toId === a)
  ));
  if (edges.length === 0) return null;
  const forward = edges.find((edge) => edge.fromId === a) ?? edges[0];
  return { fromId: forward.fromId, toId: forward.toId, mutual: edges.some((edge) => edge.mutual) || edges.length > 1 };
}

function LayerButton({ on, onClick, children, disabled }: { on: boolean; onClick: () => void; children: string; disabled?:boolean }) {
  return (
    <button disabled={disabled} type="button" className={on ? "on" : ""} aria-pressed={on} onClick={onClick}>
      <i aria-hidden="true">{on ? "✓" : ""}</i>
      {children}
    </button>
  );
}

function Swatch({ className, label }: { className: string; label: string }) {
  return <span className="pmap-legend-item"><i className={`pmap-swatch ${className}`} />{label}</span>;
}

function R2Swatch({ kind, label }: { kind: string; label: string }) {
  return <span className="pmap-legend-item"><i className={`lg-sw lg-${kind}`} />{label}</span>;
}

function LineSwatch({ color, label, dash,direction }: { color: string; label: string; dash?: boolean;direction?:"mutual"|"outbound"|"reverse" }) {
  const marker=React.useId().replace(/:/g,"");
  return (
    <span className="pmap-legend-item">
      <svg width="22" height="8" aria-hidden="true">
        {direction&&<defs><marker id={marker} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="5" markerHeight="5" markerUnits="userSpaceOnUse" orient="auto-start-reverse"><path d="M0 0 L8 4 L0 8 Z" fill={color}/></marker></defs>}
        <path d="M1 4 H21" fill="none" stroke={color} strokeWidth="2" strokeDasharray={dash ? "1.2 2.2" : undefined} strokeLinecap="round" markerStart={direction==="mutual"||direction==="reverse"?`url(#${marker})`:undefined} markerEnd={direction==="mutual"||direction==="outbound"?`url(#${marker})`:undefined}/>
      </svg>
      {label}
    </span>
  );
}



/** Floating card for a role or an evidence item. One component, one look (7b / 10b card language). */
function MapCard({
  cardRef,
  testId,
  kind,
  kicker,
  caret,
  caretX,
  leader = null,
  style,
  onClose,
  children,
}: {
  cardRef: React.RefObject<HTMLElement | null>;
  testId: string;
  kind: "role" | "evidence";
  kicker: string;
  caret: "up" | "down";
  caretX: number;
  leader?: "left" | "right" | null;
  style: React.CSSProperties;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const leaderPath = leader ? roleLeader(caretX, leader) : null;
  return (
    <aside
      ref={cardRef}
      className="pmap-card"
      data-testid={testId}
      data-map-card={kind}
      data-caret={caret}
      data-leader={leader ?? undefined}
      data-detached={leaderPath ? "true" : undefined}
      role="dialog"
      aria-label={kicker}
      style={{ ...style, width: CARD_W, ["--caret-x" as string]: `${caretX}px` }}
      onClick={(event) => event.stopPropagation()}
    >
      {leaderPath && (
        <svg
          className="pmap-card-leader"
          data-testid={`${testId}-leader`}
          width={leaderPath.width}
          height={leaderPath.height}
          viewBox={`${leaderPath.minX} ${leaderPath.minY} ${leaderPath.width} ${leaderPath.height}`}
          style={{ left: leaderPath.minX, top: leaderPath.minY, width: leaderPath.width, height: leaderPath.height }}
          aria-hidden="true"
        >
          <path className="pmap-card-leader-line" d={leaderPath.line} fill="none" stroke={ROLE_LEADER} strokeWidth={2.5} strokeLinecap="round" />
          <path className="pmap-card-leader-notch" d={leaderPath.notch} fill={ROLE_LEADER} />
        </svg>
      )}
      <header className="pmap-card-head">
        <span className="pmap-card-kicker">{kicker}</span>
        <button type="button" aria-label="Close panel" onClick={onClose}>×</button>
      </header>
      <div className="pmap-card-body" data-testid={`${testId}-body`}>{children}</div>
    </aside>
  );
}

/**
 * Leader from the caret under a role chip to a card that no longer spans it.
 * The line drops straight down from the caret, runs below the chip row, and rises
 * into the card's near top corner, at right angles. y = 1 is the middle of the card's 2px top border.
 * Coordinates are from the card's outer top-left.
 */
function roleLeader(caretX: number, side: "left" | "right"): { line: string; notch: string; minX: number; minY: number; width: number; height: number } | null {
  const edge = side === "left" ? 0 : CARD_W;
  if (side === "left" ? caretX >= edge : caretX <= edge) return null;
  const low = 26;
  const run = 1 + Math.round(low * 0.75);
  const dir = side === "left" ? 1 : -1;
  const tip = caretX - dir * 2;
  const line = treePath([{ x: tip, y: 1 }, { x: tip, y: run }, { x: edge, y: run }, { x: edge, y: 1 }]);
  const notch = `M ${edge + dir * 11} -3 L ${edge + dir * 2} 1 L ${edge + dir * 11} 5 Z`;
  const minX = Math.min(-2, tip, edge) - 8;
  const maxX = Math.max(CARD_W + 2, tip, edge + dir * 14) + 8;
  const minY = -8;
  const maxY = low + 10;
  return { line, notch, minX, minY, width: maxX - minX, height: maxY - minY };
}

export function RoleCardBody({ pkg, roleId, onOpen }: { pkg: PackageState; roleId: string; onOpen: (id: string) => void }) {
  const role = pkg.roles.find((item) => item.id === roleId);
  const controls = pkg.controls.filter((control) => control.responsibleRoleIds.includes(roleId));
  const families = pkg.map.families.length
    ? pkg.map.families.filter((family) => controls.some((control) => control.family === family.id))
    : [...new Set(controls.map((control) => control.family))].map((id) => ({ id, title: id }));
  const title = role?.title ?? roleId;
  const short = role?.shortName && role.shortName !== title ? role.shortName : null;
  return (
    <>
      <h3 className="pmap-card-title">{title}</h3>
      <p className="pmap-card-sub">
        {short ? `${short} · ` : ""}{controls.length} control{controls.length === 1 ? "" : "s"}
      </p>
      {families.map((family) => (
        <section key={family.id} className="pmap-card-group" data-family={family.id}>
          <p className="pmap-card-label">{family.id} · {family.title}</p>
          <ul>
            {controls.filter((control) => control.family === family.id).map((control) => (
              <li key={control.id}>
                <button type="button" className={`pmap-card-row ${control.complete ? "" : "bad"}`} onClick={() => onOpen(control.id)}>
                  <span className="mono">{control.id}</span>
                  <span>{control.title}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}

export function EvidenceCardBody({
  pkg,
  evidence,
  onOpen,
  onOpenControl,
  focusLabel="Open evidence focus",
}: {
  focusLabel?:string;
  pkg: PackageState;
  evidence: { id: string; displayId?: string; uuid: string; title: string; controlIds: string[] };
  onOpen: () => void;
  onOpenControl: (id: string) => void;
}) {
  const instance = evidence.uuid || evidence.id;
  const hits = evidence.controlIds.flatMap((id) => {
    const control = pkg.controls.find((item) => item.id === id);
    const item = control?.evidence.find((entry) => (entry.uuid || entry.id) === instance);
    return control && item ? [{ control, item }] : [];
  });
  const href = hits[0]?.item.href ?? "";
  return (
    <>
      <h3 className="pmap-card-title">
        <span className="mono">{evidence.displayId ?? evidence.id}</span>
        <span>{evidence.title}</span>
      </h3>
      {href ? <p className="pmap-card-link mono" title={href}>{href}</p> : null}
      <div className="pmap-card-foot">
        <ul className="pmap-chip-row" aria-label="Supports">
          {hits.map(({ control }) => (
            <li key={control.id}>
              <button type="button" className={control.complete ? "rel-chip" : "rel-chip bad"} onClick={() => onOpenControl(control.id)}>{control.id}</button>
            </li>
          ))}
        </ul>
        <button type="button" className="pmap-open-focus" onClick={onOpen}>{focusLabel}</button>
      </div>
    </>
  );
}

function PipelineArtifactCardBody({ pkg, record, name, onOpenControl }: { pkg:PackageState; record:PipelineEvidence; name:string; onOpenControl:(id:string) => void }) {
  const summary=accountScanSummary(record.collectedArtifacts?.find(a=>a.name===name));
  if(summary)return <>
    <h3 className="pmap-card-title"><span>{summary.title}</span></h3>
    <p className="pmap-card-sub">Operator-run collector on Mac · point-in-time capture.</p>
    {plantedAwsArtifact(record.collectedArtifacts?.find(a=>a.name===name))&&<p className="pmap-card-sub">Planted-gap branch: codex/phase7-cloud-baseline.</p>}
    <p className="pmap-card-sub">{summary.counts.pass} pass · {summary.counts.fail} fail · {summary.counts.error} error · {summary.counts.manual} manual · {summary.counts.not_applicable} not applicable.</p>
    <p className="pmap-card-sub">Inventory only. This does not establish a clean account, continuous scanning, control effectiveness or authorization. Planted checks are evaluated separately.</p>
    <div className="pmap-card-foot"><a className="pmap-open-focus" href={summary.href} target="_blank" rel="noopener noreferrer">Download full scan ↗</a></div>
  </>;
  const controls = controlsForArtifact(record, name);
  const check = record.checks.find((item) => item.artifact === name);
  const href = gitlabArtifactUrl(record, name);
  const linkedControls = href ? pkg.controls.filter((control) => control.evidence.some((item) => item.href === href)).map((control) => control.id) : [];
  return <>
    <h3 className="pmap-card-title"><span>{name}</span></h3>
    <p className="pmap-card-sub">Pipeline #{record.pipelineId} · job {record.artifactJobId}</p>
    <p className="pmap-card-sub mono">Commit {record.commitSha.slice(0, 12)}</p>
    {check && <p className="pmap-card-sub">{check.status.toUpperCase()} · {check.findings == null ? "No reported findings" : countLabel(check.findings,"finding")} · {check.blockingCount ?? "No reported"} blocking</p>}
    {name === "runtime.json" && record.runtime && <p className="pmap-card-sub">{record.runtime.readyCount}/{record.runtime.podCount} pods ready · {record.runtime.meshSidecarCount} sidecars · mTLS {record.runtime.mTLS}</p>}
    <section className="pmap-card-group"><p className="pmap-card-label">Reported control-level support</p><ul className="pmap-chip-row" aria-label="Pipeline supports">{controls.map((id) => <li key={id}>{pkg.controls.some((control) => control.id === id) ? <button type="button" className="rel-chip" onClick={() => onOpenControl(id)}>{id} · Level 2</button> : <span>{id} · outside package</span>}</li>)}</ul>{!controls.length && <p className="pmap-card-sub">No control mapping reported for this file. File inventory does not imply coverage.</p>}</section>
    <p className="pmap-card-sub">{linkedControls.length ? `Linked in SSP: ${linkedControls.join(", ")}.` : "Not linked into the SSP."} Import adds no statement-item or enhancement mappings; completeness is unchanged.</p>
    <div className="pmap-card-foot">{href && <a className="pmap-open-focus" href={href} target="_blank" rel="noopener noreferrer" aria-label={`Open ${name} source file`}>Open source file ↗</a>}</div>
  </>;
}
