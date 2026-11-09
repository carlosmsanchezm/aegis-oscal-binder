"use client";
import { IssueReviewDrawer } from "./IssueReviewDrawer";
import { ReleaseIssues } from "./ReleaseIssues";
import { ReleaseBundleStrip } from "./ReleaseBundleStrip";
import { GATE_WHAT } from "@/lib/aegis/gate-rows";
import { evidenceByControl,evidenceInventoryRecords } from "@/lib/collector/control-evidence";
import type { ReleaseIssue } from "@/lib/aegis/release-issues";
import { requestMessage } from "@/lib/builder/presentation";
import { countLabel } from "@/lib/builder/presentation";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { evidenceViewerHref } from "@/lib/builder/evidence-links";
import { utcTime, receiptLabel } from "@/lib/builder/presentation";
import { freshnessLabel } from "@/lib/builder/evidence";
import { BinderSummary, type ArtifactArrivalState } from "./BinderSummary";
import { ReleaseContext } from "./ReleaseContext";
import { PIPELINE_WEBHOOK_PATH, type PipelineConnection } from "@/lib/aegis/pipeline-inbound";
import { CCM_EXAMPLE, artifactFilename, gitlabArtifactUrl, parseCcmSummary, type PipelineEvidence } from "@/lib/aegis/pipeline-evidence";
import { mergeStoredReleases, releaseProject, type ControlRollupRow } from "@/lib/aegis/control-rollup";
import { coverageCounts, coverageFamilies } from "@/lib/aegis/baseline-coverage";
import { BaselineFootprint, BaselineWorkspace, CoverageFamilyInspector, DEFAULT_COVERAGE_NAVIGATION, type CoverageNavigation } from "./BaselineCoverage";
import { AssessmentDrawer, DraftDrawer, RemediationWorkspace, newPlan, useRemediation } from "./RemediationWorkspace";
import { ResetPlanReview, PlanProposalDrawer, usePlanProposals } from "./PlanProposal";
import { resolveDraftDecisions } from "@/lib/aegis/remediation-rollup";
import { proposalStatus, proposePlans, type PlanProposal } from "@/lib/aegis/plan-proposal";
import { latestReviewPlan, type Assessment, type RemediationPlan } from "@/lib/aegis/remediation";
import { blankReviewScope, type ReviewScope } from "@/lib/aegis/review-context";
import type { ArtifactMappingProposal } from "@/lib/aegis/artifact-mapping";
import { rankEffortNext } from "@/lib/aegis/effort-ranking";
import type { ArtifactMappingDecision, MapDirectedEdge } from "@/lib/aegis/types";
import {planNeedsDecision} from "@/lib/collector/control-evidence";
import { RELEASE_METRICS } from "@/lib/aegis/ui-copy";

const SAMPLE_CONTROLS = new Set(["AC-2", "AC-3", "AC-6", "AU-2", "AU-6", "CM-2", "CM-6", "IA-2", "IA-5", "SC-7", "SC-8", "SI-2"]);
const CHECK_LABELS: Record<string, string> = { sast: "SAST", dependencies: "Dependencies", image: "Image scan", configuration: "Configuration", secrets: "Secrets", "publisher-signature": "Publisher signature", "built-image-signature": "Image signature", sbom: "SBOM" };
const CCM_URL = "https://ccm-dev.vivplatform.io/p1-ccm-console/clusters/podinfo-gsa-evidence-0928";

function ArtifactLink({ record, name }: { record: PipelineEvidence; name: string }) {
  const href = evidenceViewerHref(gitlabArtifactUrl(record, name) ?? undefined, undefined, record);
  return href ? <a href={href} data-source-href={gitlabArtifactUrl(record,name) ?? undefined} target="_blank" rel="noopener noreferrer">{artifactFilename(name)} ↗</a> : <span>{artifactFilename(name)}</span>;
}

function connectionText(connection: PipelineConnection | undefined): string {
  if (!connection || connection.configured == null) return "Connection status unavailable";
  return connection.configured ? "Connection configured" : "Connection not configured";
}

type PipelineEvidenceViewProps = {
  arrival?: ArtifactArrivalState;
  onOpenMap?: () => void;
  onCollect?: () => void;
  record?: PipelineEvidence;
  onRecordChange?: (record: PipelineEvidence) => void;
  onImportRecord?: (record: PipelineEvidence) => void;
  packageControls?: string[];
  controlTitles?: Record<string, string>;
  onOpenControl?: (control: string, focus: boolean, artifact?: string, source?: PipelineEvidence) => void;
  connection?: PipelineConnection;
  receivedReleases?: PipelineEvidence[];
  proposalRecord?: PipelineEvidence;
  proposalReleases?: PipelineEvidence[];
  mappingDecisions?: ArtifactMappingDecision[];
  mappingControlIds?: string[];
  mappingCatalogId?: "fedramp-rev5" | "fedramp-20x";
  mappingStorageNote?: string | null;
  onMappingDecision?: (proposal: ArtifactMappingProposal, status: "accepted" | "rejected", controls?: string[], reviewer?: string, source?: PipelineEvidence) => Promise<void>;
  relationships?: MapDirectedEdge[];
  coverageNavigation?: CoverageNavigation;
  onCoverageNavigation?: (navigation: CoverageNavigation) => void;
};

type FocusDecisions = { focused: string | null; dismissed: string[] };
const EMPTY_FOCUS_DECISIONS: FocusDecisions = { focused: null, dismissed: [] };

function readFocusDecisions(key: string): FocusDecisions {
  try {
    const value = JSON.parse(window.sessionStorage.getItem(key) ?? "null") as Partial<FocusDecisions> | null;
    if (!value || (value.focused !== null && typeof value.focused !== "string") || !Array.isArray(value.dismissed)) return EMPTY_FOCUS_DECISIONS;
    const dismissed = value.dismissed.filter((id): id is string => typeof id === "string").slice(0, 500);
    return { focused: value.focused ?? null, dismissed: [...new Set(dismissed)] };
  } catch {
    return EMPTY_FOCUS_DECISIONS;
  }
}

export function PipelineEvidenceView(incoming: PipelineEvidenceViewProps) {
  const { record: supplied, onRecordChange, packageControls, onOpenControl, connection, receivedReleases = [] } = incoming ?? {};
  const [localRecord, setLocalRecord] = useState<PipelineEvidence>(CCM_EXAMPLE);
  const sourceRecord = supplied ?? localRecord;
  const record = useMemo(() => mergeStoredReleases([sourceRecord], sourceRecord.pipelineUrl).find(item => item.pipelineUrl === sourceRecord.pipelineUrl && item.commitSha === sourceRecord.commitSha && item.releaseSha256 === sourceRecord.releaseSha256) ?? sourceRecord, [sourceRecord]);
  const remediation = useRemediation(record);
  const [assessmentOpen, setAssessmentOpen] = useState(false);
  const [reviewItem, setReviewItem] = useState("");
  const [reviewScope, setReviewScope] = useState<ReviewScope | undefined>();
  const [assessmentSnapshot, setAssessmentSnapshot] = useState<Assessment | null>(null);
  const [draft, setDraft] = useState<RemediationPlan | null>(null);
  const [openPlan, setOpenPlan] = useState<string | null>(null);
  const [openProposalId, setOpenProposalId] = useState<string | null>(null);
  const [issueReview,setIssueReview]=useState<{issue:ReleaseIssue;control:string}|null>(null);
  const [localIssueDraft,setLocalIssueDraft]=useState<PlanProposal|null>(null);
  const planProposals = usePlanProposals();
  const reviewItems=[...(record.reviewItems??[]).map(item=>({description:item.description,scope:item.scope})),...record.gaps.map(description=>({description,scope:undefined as ReviewScope|undefined}))];
  const savedPlan = remediation.plans.find((p) => p.id === openPlan);
  const reviewDraft = latestReviewPlan(remediation.plans, record, reviewItem);
  useEffect(() => { setAssessmentOpen(false); setAssessmentSnapshot(null); setDraft(null); setOpenPlan(null); }, [record.pipelineUrl, record.commitSha]);
  const [localNavigation, setLocalNavigation] = useState(DEFAULT_COVERAGE_NAVIGATION);
  const navigation = incoming.coverageNavigation ?? localNavigation;
  const setNavigation = (next: CoverageNavigation) => {
    (incoming.onCoverageNavigation ?? setLocalNavigation)(next);
    if (next.expanded && !navigation.expanded) incoming.onOpenMap?.();
  };
  const selectedFamily = navigation.family;
  const setSelectedFamily = (family: string | null) => setNavigation({ ...navigation, family });
  const [detail, setDetail] = useState<"ranking" | "review" | "policy">("policy");
  const [releaseSelected, setReleaseSelected] = useState(true);
  const [focusedReview, setFocusedReview] = useState<string | null>(null);
  const detailRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!selectedFamily || navigation.expanded) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") setNavigation({ ...navigation, family: null }); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [selectedFamily, navigation, setNavigation]);
  useEffect(() => { if (detail && !selectedFamily) detailRef.current?.focus({preventScroll:true}); }, [detail, selectedFamily]);
  const [error, setError] = useState<string | null>(null);
  const [label, setLabel] = useState("Release snapshot · source reported in summary");
  const inPackage = packageControls ? new Set(packageControls) : SAMPLE_CONTROLS;
  const projectUrl = record.pipelineUrl.replace(/\/-\/pipelines\/\d+$/, "");
  const exampleRelease = record.pipelineUrl === CCM_EXAMPLE.pipelineUrl;
  const scannerRun = record.schema === "aegis.evidence-event.v1" && record.observation.producer === "GitHub Actions" ? record.collectedArtifacts?.find(a=>a.source.url && /^https:\/\/github\.com\/[^/]+\/[^/]+\/actions\/runs\/\d+$/.test(a.source.url))?.source.url : undefined;
  const runId = scannerRun ? record.artifactJobId : record.pipelineId;
  const runtimeArtifact = scannerRun ? record.collectedArtifacts?.find(a=>a.source.path === "runtime.json") : undefined;
  const runtimeFact = (field:string) => runtimeArtifact?.facts.find(f=>f.field===field)?.value;
  const imageSummary = scannerRun ? record.collectedArtifacts?.find(a=>a.source.path === "summary.json") : undefined;
  const frontendImage = imageSummary?.facts.find(f=>f.field==="images.frontend.digest")?.value;

  const sourceHref = exampleRelease ? `${projectUrl}/-/commit/${record.commitSha}` : record.pipelineUrl;
  const webhookPath = connection?.webhookPath || PIPELINE_WEBHOOK_PATH;
  const selectionNote = connection?.inboundSelected
    ? "showing the received event"
    : exampleRelease && record.commitSha === CCM_EXAMPLE.commitSha
      ? "recorded original release · curated snapshot"
      : "showing the release loaded in this tab";
  const storedReleases = useMemo(() => mergeStoredReleases([...receivedReleases, record], record.pipelineUrl), [receivedReleases, record]);
  const reviewedPlans = useMemo(() => remediation.plans.map(plan => resolveDraftDecisions(plan, storedReleases)), [remediation.plans, storedReleases]);
  const localProposals = useMemo(() => proposePlans(storedReleases), [storedReleases]);
  const proposals = planProposals?.proposals ?? localProposals;
  const decisionPlans=proposals.filter(planNeedsDecision);
  const decisionControlCount=new Set(decisionPlans.map(plan=>plan.controlId)).size;
  const proposalName = (proposal: PlanProposal) => `${proposal.controlId}${proposals.filter(item => item.controlId === proposal.controlId).length > 1 ? ` · ${proposal.findingTitle}` : ""}`;
  const openProposal = proposals.find((proposal) => proposal.id === openProposalId) ?? (localIssueDraft?.id === openProposalId ? localIssueDraft : null);
  const baselineFamilies = useMemo(() => coverageFamilies(record, storedReleases, false), [record, storedReleases]);
  const accumulatedFamilies = useMemo(() => coverageFamilies(record, storedReleases, true), [record, storedReleases]);
  const releaseCoverage = coverageCounts(baselineFamilies.flatMap(f => f.controls));
  const selected = (releaseSelected ? baselineFamilies : accumulatedFamilies).find((item) => item.id === selectedFamily) ?? null;
  const focusStorageKey = useMemo(() => `binder.next-focus.v1:${releaseProject(record.pipelineUrl)}`, [record.pipelineUrl]);
  function selectDetail(next: "ranking" | "review" | "policy") {
    setDetail(next); detailRef.current?.focus();
    try {sessionStorage.setItem(focusStorageKey+":inspector",next);} catch {/* In-memory choice remains usable. */}
  }
  useEffect(()=>{try {const saved=sessionStorage.getItem(focusStorageKey+":inspector");setDetail(saved === "ranking" || saved === "review" ? saved : "policy");}catch{/* Default to Findings. */}},[focusStorageKey]);
  const [focusDecisions, setFocusDecisions] = useState<FocusDecisions>(EMPTY_FOCUS_DECISIONS);
  useEffect(() => setFocusDecisions(readFocusDecisions(focusStorageKey)), [focusStorageKey]);
  const rankedEfforts = useMemo(() => rankEffortNext({
    rows: accumulatedFamilies.flatMap(family => family.controls),
    relationships: incoming.relationships ?? [],
    plans: remediation.plans,
    postureLabel: "FedRAMP Rev5 Moderate",
  }), [accumulatedFamilies, incoming.relationships, remediation.plans]);
  const recommendations = rankedEfforts.filter(item => !(proposals.some(p=>p.controlId===item.controlId) && proposals.filter(p=>p.controlId===item.controlId).every(p=>p.closureConfirmed)) && !focusDecisions.dismissed.includes(item.id)).slice(0, 5);

  function saveFocusDecisions(next: FocusDecisions) {
    setFocusDecisions(next);
    try {
      window.sessionStorage.setItem(focusStorageKey, JSON.stringify(next));
    } catch {
      // The choice remains in memory when session storage is unavailable.
    }
  }

  async function importSummary(file: File | undefined) {
    if (!file) return;
    if (file.size > 512_000) { setError("Use a CCM summary smaller than 500 KB, not a raw artifact archive."); return; }
    try {
      const next = parseCcmSummary(JSON.parse(await file.text()));
      (incoming.onImportRecord ?? onRecordChange ?? setLocalRecord)(next);
      setSelectedFamily(null);
      setLabel(`Loaded locally from ${file.name} · no server upload`);
      setError(null);
    } catch (cause) { setError(requestMessage(cause,"Could not read the CCM summary.")); }
  }

  function controlAction(id: string, focus: boolean, artifact?: string, source?: PipelineEvidence) {
    if (onOpenControl) onOpenControl(id, focus, artifact, source);
    else window.location.assign(`/planning?control=${encodeURIComponent(id)}&pipeline=${focus ? "1" : "0"}${artifact ? `&artifact=${encodeURIComponent(artifactFilename(artifact))}` : ""}`);
  }

  function openReview(row?: ControlRollupRow) {
    const result = row?.result;
    const source = result && storedReleases.find(r => r.pipelineUrl === result.sourceReleaseUrl && r.commitSha === result.sourceCommit && r.releaseSha256 === result.sourceReleaseSha256);
    if (source) (onRecordChange ?? setLocalRecord)(source);
    setFocusedReview(result?.finding || null);
    setNavigation({...navigation,expanded:false,family:null});
    selectDetail("review");
  }

  function openIssue(issue: ReleaseIssue, control: string) { setIssueReview({issue,control}); }

  if (savedPlan) return <><RemediationWorkspace key={savedPlan.id} saved={savedPlan} record={record} receivedReleases={receivedReleases} onSave={remediation.savePlan} onBack={() => setOpenPlan(null)} onFinding={() => { setReviewItem(savedPlan.source.reviewItem); setAssessmentSnapshot(savedPlan.assessment); setOpenPlan(null); setAssessmentOpen(true); }} onControl={inPackage.has(savedPlan.control)?()=>controlAction(savedPlan.control,true):undefined} />{remediation.storageError && <p role="alert" className="pipeline-error">{remediation.storageError}</p>}</>;

  const footprint = <BaselineFootprint suggested={new Set(evidenceByControl(evidenceInventoryRecords(incoming.proposalRecord ?? record,incoming.proposalReleases ?? receivedReleases),incoming.mappingControlIds ?? packageControls ?? [],incoming.mappingCatalogId,incoming.mappingDecisions).controls.filter(c=>c.suggested.length).map(c=>c.id))} accumulated={!releaseSelected} families={releaseSelected ? baselineFamilies : accumulatedFamilies} selected={selectedFamily} onSelect={id => setSelectedFamily(selectedFamily === id ? null : id)} onExpand={() => setNavigation({...navigation,expanded:true})} />;
  return <section className={`release-dashboard release-converged r3-release${navigation.expanded ? " coverage-expanded" : ""}`} aria-label="Release evidence dashboard" data-testid="release-dashboard">
    {assessmentOpen && reviewItem && <AssessmentDrawer key={reviewItem} record={record} reviewItem={reviewItem} initial={assessmentSnapshot ?? {...remediation.assessmentFor(reviewItem),scope:remediation.assessmentFor(reviewItem).scope??reviewScope??blankReviewScope()}} onSave={a=>remediation.saveAssessment(a,reviewItem)} onClose={() => { setAssessmentOpen(false); setAssessmentSnapshot(null); }} onOpenSavedDraft={reviewDraft ? () => { setAssessmentOpen(false); setAssessmentSnapshot(null); setOpenPlan(reviewDraft.id); } : undefined} onPrepare={(assessment) => { setAssessmentOpen(false); setAssessmentSnapshot(null); setDraft(newPlan(record, reviewItem, assessment, `DRAFT-${crypto.randomUUID()}`, new Date().toISOString())); }} />}
    {draft && <DraftDrawer key={draft.id} plan={draft} onClose={() => setDraft(null)} onBack={() => { setDraft(null); setAssessmentOpen(true); }} onSave={async (p) => { await remediation.savePlan(p); setDraft(null); setOpenPlan(p.id); }} />}
    <ReleaseContext record={record} selected={releaseSelected}><details className="release-sources-menu"><summary>Sources ▾</summary><div>{exampleRelease && <a href={CCM_URL} target="_blank" rel="noopener noreferrer">ENBUILD release ↗</a>}{exampleRelease ? <a href={record.pipelineUrl} target="_blank" rel="noopener noreferrer">GitLab pipeline ↗</a> : <a href={evidenceViewerHref(record.pipelineUrl, undefined, record)} target="_blank" rel="noopener noreferrer">Pipeline run ↗</a>}{record.schema === "aegis.evidence-event.v1" ? <span>Retained system observation · producer identity unverified</span> : connection?.inboundSelected ? <span>Received signed event · no vendor connection</span> : <span>Snapshot only · no live connection</span>}<span>No FedRAMP authorization or agency ATO</span>{connection?.inboundSelected ? <span>A pipeline pass does not record validation or closure</span> : null}</div></details>
      {record.schema !== "aegis.evidence-event.v1" && <><label className="pipeline-import">Import CCM summary JSON<input type="file" accept=".json,application/json" onChange={(event) => { void importSummary(event.currentTarget.files?.[0]); event.currentTarget.value = ""; }} /></label>
      <small>read locally</small></>}</ReleaseContext>
    <div className="release-content">{!navigation.expanded && <div className="release-title"><h1>Release evidence</h1>{storedReleases.length > 0 && <div className="release-selector"><label>Release <select aria-label="Release selection" value={releaseSelected ? JSON.stringify([record.pipelineUrl,record.commitSha,record.releaseSha256]) : ""} onChange={e => {
      setReleaseSelected(Boolean(e.target.value));
      const next = storedReleases.find(r => JSON.stringify([r.pipelineUrl,r.commitSha,r.releaseSha256]) === e.target.value);
      if (next) (onRecordChange ?? setLocalRecord)(next);
    }}><option value="">Select a stored release</option>{storedReleases.map(r => <option key={`${r.pipelineUrl}:${r.commitSha}:${r.releaseSha256}`} value={JSON.stringify([r.pipelineUrl,r.commitSha,r.releaseSha256])}>#{receiptLabel(r.pipelineId)} · {r.pipelineId === CCM_EXAMPLE.pipelineId ? "original snapshot" : r.verification ? "received retest" : "received"}</option>)}</select></label>{record.verification && <span>{record.verification.tests.length} measured tests · reviewer decision separate</span>}</div>}</div>}



    {error && <p role="alert" className="pipeline-error">{error}</p>}
    {remediation.storageError && <p role="alert" className="pipeline-error">{remediation.storageError}</p>}
    {releaseSelected && !navigation.expanded && <ReleaseBundleStrip bundle={record.schema === "aegis.evidence-event.v1" ? record.releaseEvidence : undefined} onOpen={setOpenProposalId} loading={planProposals?.loading} />}
    {navigation.expanded ? incoming.onOpenMap ? <><button type="button" className="coverage-text-action" onClick={() => setNavigation({...navigation,expanded:false})}>← Release overview</button><button type="button" className="btn primary" onClick={incoming.onOpenMap}>Open package map</button></> : <BaselineWorkspace families={accumulatedFamilies} history={storedReleases} record={record} navigation={navigation} onNavigation={setNavigation} onOpenControl={controlAction} onReview={openReview} /> : <>
    {releaseSelected && <div className="r3-evidence-row">
        {!navigation.expanded && releaseSelected && <BinderSummary record={incoming.proposalRecord ?? record} records={incoming.proposalReleases ?? receivedReleases} decisions={incoming.mappingDecisions} controlIds={incoming.mappingControlIds ?? packageControls ?? []} catalogId={incoming.mappingCatalogId} arrival={incoming.arrival} controlTitles={incoming.controlTitles} plans={proposals} onOpenPlan={setOpenProposalId} onOpenMap={()=>setNavigation({...navigation,expanded:true})} onDecision={incoming.onMappingDecision} storageNote={incoming.mappingStorageNote} />}
        {releaseSelected ? <><section className="release-card release-chain-card"><div className="r3-chain-open"><div className="release-section-title"><h2>Release chain</h2></div><div className="release-readiness" data-blocked={(record.schema === "aegis.evidence-event.v1" ? record.observation.reportedOutcome : record.policyVerdict) !== "pass" ? "true" : undefined}><div><strong>{(record.schema === "aegis.evidence-event.v1" ? record.observation.reportedOutcome : record.policyVerdict) === "pass" ? "Cleared to ship" : "Blocks release"}</strong></div></div>
          {scannerRun ? <>
            <div className="release-chain">
              <div><span>Source commit</span><strong title={record.commitSha}>{record.commitSha.slice(0,12)}</strong><a href={`${record.schema === "aegis.evidence-event.v1" ? record.observation.subject.id : ""}/commit/${record.commitSha}`} target="_blank" rel="noopener noreferrer">View source ↗</a></div>
              <div><span>Pipeline</span><strong>#{runId}</strong><a href={scannerRun} target="_blank" rel="noopener noreferrer">{countLabel(record.checks.length,"check")} · {record.policyVerdict.toUpperCase()} ↗</a></div>
              <div><span>Image</span><strong title={String(frontendImage??"")}>{typeof frontendImage === "string" ? frontendImage.slice(7,19)+"…" : "Result unavailable"}</strong><span>{imageSummary ? `${imageSummary.facts.find(f=>f.field==="images.count")?.value} built images` : "Built image identity unavailable"}</span>{imageSummary && <ArtifactLink record={record} name={imageSummary.name}/>}</div>
              <div><span>Signature</span><strong>Result unavailable</strong><span>Local images are unsigned</span></div>
              <div><span>Reviewer decision</span><strong>No deployment approval supplied</strong></div>
              <div><span>Runtime</span><strong>{runtimeFact("pods.ready")}/{runtimeFact("pods.count")} pods ready</strong><span>{runtimeFact("probe.healthy")===true?"Probe passed":"Probe unavailable or failed"}</span>{runtimeArtifact && <ArtifactLink record={record} name={runtimeArtifact.name}/>}</div>
            </div>
            <div className="release-seal"><details><summary>Evidence seal <code>sha256:{record.releaseSha256.slice(0,20)}…</code></summary><code>{record.releaseSha256}</code><p>Observed {utcTime(record.createdAt,true)}. Artifact digests checked. Producer identity unverified. Human review remains separate.</p><a href={record.pipelineUrl}>Download retained bundle</a></details></div>
          </> : record.schema === "aegis.evidence-event.v1" ? <>
            <div className="release-chain">
              <div><span>System</span><strong>{record.observation.systemName}</strong><span>{record.observation.subject.kind}</span></div>
              <div><span>Assessed subject</span><strong title={record.observation.subject.id}>{record.observation.subject.kind}</strong><details><summary>Full identity</summary><code>{record.observation.subject.id}</code><p>Revision {record.commitSha}</p></details></div>
              <div><span>Producer</span><strong title={record.observation.producer}>{record.observation.producer}</strong><details><summary>Details</summary><code>{record.observation.producer}</code><p>Identity unverified</p></details></div>
              <div><span>Evidence integrity</span><strong>Artifact digests checked</strong><a href={record.pipelineUrl}>Download retained bundle</a></div>
              <div><span>Reviewer decision</span><strong>Separate review required</strong><span>No deployment approval supplied</span></div>
            </div>
            <div className="release-seal"><details><summary>Retained receipt <code>sha256:{record.releaseSha256.slice(0, 20)}…</code></summary><code>{record.releaseSha256}</code><p>Observed {utcTime(record.createdAt,true)}. {record.signatureScope} Artifact digests preserve the received bytes; applicability and control effectiveness require review.</p></details></div>
          </> : <>
          <div className="release-chain">
            <div><span>Source commit</span><strong title={record.commitSha}>{record.commitSha.slice(0, 12)}</strong><a href={sourceHref} target="_blank" rel="noopener noreferrer">{exampleRelease ? "View source ↗" : "View pipeline ↗"}</a></div>
            <div><span>Pipeline</span><strong>#{runId}</strong><a href={scannerRun ?? evidenceViewerHref(record.pipelineUrl, undefined, record)} target="_blank" rel="noopener noreferrer">{countLabel(record.checks.length,"check")} · {record.policyVerdict.toUpperCase()} ↗</a></div>
            <div><span>Image</span><strong title={record.image ?? undefined}>{record.image?.split("@sha256:")[1]?.slice(0, 12) ?? "See source"}…</strong><span>digest</span></div>
            <div><span>Signature</span><strong>{record.signatureStatus}</strong><span>reported by job</span><ArtifactLink record={record} name="release.sigstore.json" /></div>
            <div><span>{!record.approval?.actor ? "Reviewer decision" : record.approval?.mode==="vendor-test"?"Automated vendor test · no independent review":record.approval?.mode==="independent-review"?"Independent review":"Deployment receipt · review mode not supplied"}</span><strong>{record.approval?.actor || "No deployment approval supplied"}</strong>{record.approval?.actor && <><span>{record.approval.approvedAt.slice(11, 16)} UTC</span><ArtifactLink record={record} name="approval.json" /></>}</div>
            <div><span>Runtime</span><strong>{record.runtime?.readyCount}/{record.runtime?.podCount} pods ready</strong><span>Sidecars {record.runtime?.meshSidecarCount}/{record.runtime?.podCount}</span><ArtifactLink record={record} name="runtime.json" /></div>
          </div>
          <div className="release-seal"><details className="release-source"><summary>Evidence seal <code>sha256:{record.releaseSha256.slice(0, 20)}…</code></summary><p>{connection?.inboundSelected ? `Received signed pipeline event${connection.receivedAt ? ` · ${connection.receivedAt}` : ""}` : `${label} · ${record.createdAt}`}</p><code>{record.releaseSha256}</code><p>{connection?.inboundSelected ? "Webhook verification checks the shared secret only. A pipeline pass does not record validation or closure, and this viewer does not assess control effectiveness. Import only data approved for this environment." : "Snapshot only · no live GitLab connection · this viewer does not verify signatures or assess control effectiveness. Import only data approved for this environment."}</p></details><span title="Observation reported by the producing job">mTLS · {record.runtime?.mTLS}</span></div>
          </>}
        </div></section><div className="release-paired"><section className="release-card">
          <div className="release-section-title"><h2>Release gates</h2><a className="r3-run-link" href={scannerRun ?? record.pipelineUrl} target="_blank" rel="noopener noreferrer">Pipeline #{runId} ↗</a></div>
          <div className="release-check-grid">{record.checks.map((check) => <article key={check.id} className={record.schema === "aegis.evidence-event.v1" ? "observation-check" : undefined}><div>{record.schema === "aegis.evidence-event.v1" ? <a className="release-check-open" href={evidenceViewerHref(record.pipelineUrl, check.id)} target="_blank" rel="noopener noreferrer"><strong>{CHECK_LABELS[check.id] ?? check.id}</strong> ↗</a> : <strong>{CHECK_LABELS[check.id] ?? check.id}</strong>}<span className="r3-gate-what">{GATE_WHAT[check.id] ?? ""}</span><b className={(check.reportedVerdict ?? check.status) === "pass" ? "good" : (check.reportedVerdict ?? check.status) === "fail" ? "bad" : "hint"}>{(check.reportedVerdict??check.status)==='pass'?<span className="r3-sr">Nothing blocks release</span>:(check.reportedVerdict??check.status)==='fail'?'Blocks release':'Result unavailable'}</b></div><div><span>{check.blockingCount ? `${check.blockingCount} blocking findings` : ""}</span><a href={evidenceViewerHref(gitlabArtifactUrl(record,check.artifact) ?? undefined,undefined,record)} title={check.artifact} target="_blank" rel="noopener noreferrer">Result ↗</a></div>{proposals.filter(p=>!p.closureConfirmed && p.result?.sourceArtifacts.some(a=>artifactFilename(a.name)===artifactFilename(check.artifact))).map(p=><button type="button" className={planNeedsDecision(p)?"scan-decision-action":"text-btn"} key={p.id} data-check-plan={p.id} onClick={()=>setOpenProposalId(p.id)}>{planNeedsDecision(p)?"Your decision needed":"Waiting on a retest"} · {p.controlId} · Open →</button>)}{check.reportedVerdict && <p>Evidence freshness: {freshnessLabel(check.status)} · valid until {utcTime(check.validUntil ?? "",true)}{check.status === "stale" && <button type="button" className="text-btn" onClick={incoming.onCollect}>Collect fresh retest →</button>}</p>}</article>)}</div>
         </section></div></> : <section className="release-card release-unselected"><h2>No release selected</h2><p>Choose a stored release to fill in its chain, checks and release-specific coverage. Workspace coverage, the footprint and existing plans stay as they are.</p></section>}

        {footprint}
        {releaseSelected && <ReleaseIssues record={record} plans={proposals} releases={storedReleases} titles={incoming.controlTitles} onOpen={setOpenProposalId} onAction={openIssue} />}
      </div>}
    {record.schema !== "aegis.evidence-event.v1" && <details className="release-webhook" data-testid="pipeline-webhook"><summary>{connectionText(connection)} · {selectionNote}</summary><code>POST {webhookPath}</code></details>}
      <div className="release-grid"><div className="release-left">{!releaseSelected && <><section className="release-card release-unselected"><h2>No release selected</h2><p>Choose a stored release to fill in its chain, checks and release-specific coverage. Workspace coverage, the footprint and existing plans stay as they are.</p></section>{footprint}</>}</div>
      <aside ref={detailRef} tabIndex={-1} id="release-detail-panel" className="release-card release-inspector" aria-label={detail === "policy" ? "Pipeline policy findings" : detail === "review" ? "Open review items" : "Recommended next efforts"}>
        <div className="release-inspector-tabs" aria-label="Release inspector">{([["policy","Findings"],["review",`Review items ${releaseSelected ? reviewItems.length : ""}`],["ranking",`Effort ${releaseSelected ? recommendations.length : ""}`]] as const).map(([id,label]) => <button type="button" key={id} aria-pressed={detail === id} onClick={() => {setSelectedFamily(null);selectDetail(id);}}>{label}</button>)}</div>
        <div className="release-inspector-body">
        {!releaseSelected ? <><h2>No release-specific items</h2><p className="release-note">Select a release to see findings, review items and recommended effort. Workspace plans below are unchanged.</p></> : detail === "policy" ? <>
          <div className="release-section-title"><h2>Pipeline policy findings</h2><button type="button" className="coverage-text-action" onClick={() => selectDetail("ranking")}>Effort ranking →</button></div>
          <p className="release-note">{record.schema === "aegis.evidence-event.v1" ? `Captured outcome ${record.observation.reportedOutcome.toUpperCase()} · evidence ${[...new Set(record.checks.map(c => freshnessLabel(c.status)))].join(", ")}; current posture is not established by expired evidence.` : `Policy ${record.policyVerdict.toUpperCase()}`} · findings are retained for triage, not cleared by a pass.</p>
          <h3>Selected release · observation</h3><div className="release-policy-details">{record.checks.map((check) => <section key={check.id}>{record.schema === "aegis.evidence-event.v1" ? <strong>{CHECK_LABELS[check.id] ?? check.id}</strong> : <strong>{CHECK_LABELS[check.id] ?? check.id}</strong>}<span>{check.findings == null ? "Inventory" : countLabel(check.findings,"finding")} · {check.blockingCount ?? "Not reported"} blocking</span>{record.schema === "aegis.evidence-event.v1" ? <span>{artifactFilename(check.artifact)}</span> : <ArtifactLink record={record} name={check.artifact} />}</section>)}</div>
          {proposals.length > 0 && <div className="release-retained-findings"><h3>Retained scoped findings</h3>{proposals.map(proposal => <article key={proposal.id}><strong>{proposal.controlId} · scoped finding</strong><span>{storedReleases.find(r => r.pipelineId === proposal.sourceReleaseId)?.verification ? "Retest" : "Original failed observation"} <b className="mono">#{receiptLabel(proposal.sourceReleaseId)}</b></span>{storedReleases.find(r=>r.pipelineId === proposal.sourceReleaseId)?.verification && <span> · linked to original #{receiptLabel(storedReleases.find(r=>r.pipelineId === proposal.sourceReleaseId)?.verification?.sourcePipelineUrl.split("/").at(-1) ?? "")}</span>}<span className="pill miss">{proposal.closureConfirmed ? "Closure decision recorded" : "Open"}</span><p>A newer PASS does not close this finding. Review the plan and obtain a qualifying fresh retest before closure.</p><div><button className="btn ghost" type="button" onClick={() => setOpenProposalId(proposal.id)}>{`Open plan of action · ${proposal.closureConfirmed ? "closed" : proposal.acceptance === "accepted" ? "accepted" : "draft"}`}</button><button className="text-btn" type="button" onClick={incoming.onCollect}>Collect fresh retest →</button></div></article>)}</div>}
          <div className="release-review-bottom"><ArtifactLink record={record} name="findings.json" /><p>Individual finding records remain in the source artifact.</p></div>
        </> : detail === "review" ? <>
          <div className="release-section-title"><h2>Open review items</h2><button type="button" className="coverage-text-action" onClick={() => selectDetail("ranking")}>Effort ranking →</button></div><p className="release-note">Observation → reviewer assessment → scoped action.</p>
          <ol className="release-review-list">{reviewItems.map((item, index) => <li key={item.description}><span>{index + 1}</span><div><details className="release-review-detail" open={focusedReview === item.description ? true : undefined}><summary><span title={item.description}>{item.scope?.title??item.description}</span></summary><p>{item.description}</p></details><button type="button" aria-label={`Assess review item ${index+1}`} disabled={remediation.loading} className="rem-text-button" onClick={() => {setReviewItem(item.description);setReviewScope(item.scope);setAssessmentSnapshot(null);setAssessmentOpen(true);}}>{remediation.loading ? "Loading record…" : "Assess →"}</button></div><span className="release-role-suggestion">suggest {item.description.includes("POA&M") ? "ISSO" : "ISSE"}</span></li>)}</ol>


          <div className="release-review-bottom"><strong>{countLabel(record.findingCount,"finding")} retained for triage</strong><ArtifactLink record={record} name="findings.json" /><p>Official POA&M tracking stays in the approved agency system.</p></div>
        </> : <>
          <div className="release-section-title"><h2>Next work</h2><span>{recommendations.length} shown</span></div>
          <p className="release-note">Ranked from stored evidence, posture blanks, catalog relationships and open internal plans. A person chooses; this does not establish satisfaction or authorization.</p>
          <ol className="effort-ranking-list">
            {recommendations.map((item, index) => {
              const focused = focusDecisions.focused === item.id;
              const itemProposals = proposals.filter(proposal => proposal.controlId === item.controlId);
              const primary = itemProposals[0];
              const openPrimary = () => {
                if (primary) setOpenProposalId(primary.id);
                else if (item.kind === "open-finding") controlAction(item.controlId, false);
                else controlAction(item.controlId, true);
              };
              const primaryLabel = primary ? "Open plan of action" : item.kind === "open-finding" ? `Show ${item.controlId} on map` : `Open ${item.controlId} in Level 2`;
              return <li key={item.id} data-recommendation={item.id} data-kind={item.kind}>
                <div className="effort-ranking-heading"><span className="effort-rank">{index + 1}</span><button type="button" className="effort-control" onClick={openPrimary}><strong>{item.controlId}</strong></button><small className={item.kind === "open-finding" ? "pill fail" : "pill miss"}>{item.kind === "open-finding" ? "Finding" : "Blank"}</small><button type="button" className={index === 0 ? "btn primary" : "btn ghost"} onClick={openPrimary}>{primaryLabel}</button><details className="effort-more"><summary aria-label={`More actions for ${item.controlId}`}>⋯</summary>
                  {itemProposals.slice(1).map(proposal => <button key={proposal.id} type="button" aria-label={`Open plan for ${proposalName(proposal)}`} onClick={() => setOpenProposalId(proposal.id)}>Open plan of action</button>)}
                  {focused ? <span className="effort-focused">Next focus · person selected</span> : <button type="button" onClick={() => saveFocusDecisions({ ...focusDecisions, focused: item.id })}>Set as next focus</button>}
                  <button type="button" onClick={() => saveFocusDecisions({ focused: focusDecisions.focused === item.id ? null : focusDecisions.focused, dismissed: [...new Set([...focusDecisions.dismissed, item.id])] })}>Dismiss</button>
                </details></div>
                <details className="effort-reasons"><summary>{item.costReason}</summary><p>{item.riskReason}</p><p>{item.relevanceReason}</p></details>
              </li>;
            })}
          </ol>
          {recommendations.length === 0 && <p className="release-note">No recommendations remain in this session. Restore dismissed items to rank them again.</p>}
          {focusDecisions.dismissed.length > 0 && <button type="button" className="coverage-text-action effort-restore" onClick={() => saveFocusDecisions({ ...focusDecisions, dismissed: [] })}>Restore {focusDecisions.dismissed.length} dismissed recommendation{focusDecisions.dismissed.length === 1 ? "" : "s"}</button>}

        </>}
        </div>
          <ResetPlanReview /><div className="rem-saved-plans" data-testid="proposed-plans"><h3>Plans of action · {proposals.length} <small>{planProposals?.loading ? "Loading saved decisions…" : <>{proposals.filter(p=>p.acceptance!=="accepted").length} proposed · {proposals.filter(p=>p.acceptance==="accepted"&&!p.closureConfirmed).length} accepted · {proposals.filter(p=>p.closureConfirmed).length} closed · workspace-wide</>}</small></h3>{proposals.map(proposal => <button key={proposal.id} type="button" aria-label={`Open proposed plan ${proposalName(proposal)}`} disabled={planProposals?.loading} onClick={() => setOpenProposalId(proposal.id)}><strong>{proposal.controlId} · {proposal.findingTitle}</strong><small>{planProposals?.loading ? "Loading saved plan decisions…" : proposalStatus(proposal)} →</small></button>)}{!proposals.length && <p className="release-note">None yet</p>}</div>
          <div className="rem-saved-plans" data-testid="internal-plans"><h3>Internal POA&M drafts · {remediation.plans.length}</h3>{reviewedPlans.map((p) => <button key={p.id} type="button" onClick={() => setOpenPlan(p.id)}><strong>{p.weakness}</strong><small>{p.closure.recorded ? "External decision recorded" : p.readyForReview ? "Internal package prepared" : "Draft · open"} →</small></button>)}{!remediation.plans.length && <p className="release-note">None yet</p>}</div>
      </aside>
    </div>
    {selected && <div className="coverage-family-overlay"><CoverageFamilyInspector key={selected.id} family={selected} history={storedReleases} accumulated={false} onClose={() => setSelectedFamily(null)} onExpand={() => setNavigation({...navigation,expanded:true})} onOpenControl={controlAction} onReview={openReview} /></div>}
    </>}
    </div>
    {issueReview && <IssueReviewDrawer record={issueReview.issue.source ?? record} issue={issueReview.issue.observation ?? record.reviewItems?.find(i=>i.scope.artifacts.includes(issueReview.issue.file))} action={issueReview.issue.button === "Triage" ? "triage" : "draft"} onClose={()=>setIssueReview(null)} onDraft={proposal=>{planProposals?.addIssueDraft(proposal);setLocalIssueDraft(proposal);setIssueReview(null);setOpenProposalId(proposal.id);}} />}
    {openProposal && <PlanProposalDrawer proposal={openProposal} onClose={() => setOpenProposalId(null)} />}
  </section>;
}
