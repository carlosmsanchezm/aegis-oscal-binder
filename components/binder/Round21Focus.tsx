"use client";
import { moderateControls } from "@/lib/aegis/moderate-baseline";
import { countLabel, receiptLabel,utcTime } from "@/lib/builder/presentation";
import {observationControl} from "@/lib/aegis/connected-evidence";
import type {PipelineEvidence} from "@/lib/aegis/pipeline-evidence";
import {StatementMappingDialog,useStatementMappingReviews} from "./StatementMappingReview";
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { directedLinksFor, statementAddressed, itemEvidenceLinks, resolvedStatementProse } from "@/lib/aegis/map-view";
import { controlFaceStatus, faceLines } from "@/lib/aegis/map-layout";
import { busRoute, treePath } from "@/lib/aegis/selected-tree";
import type { ControlView, PackageState } from "@/lib/aegis/types";
import { StatementRow, useStageSize } from "./ControlFocus";

const FLOOR = { width: 1, height: 1 };
export function Round21Focus({
  pkg,
  control,
  pipelineControl,
  observed = false,
  observedRecord,
  selectedItemId,
  onSelectItem,
  onBack,
  onSelect,
  onEvidence,
  onInspectEvidence,
  snapshotSelector,
}: {
  pkg: PackageState;
  control: ControlView;
  pipelineControl?: ControlView;
  observed?: boolean;
  observedRecord?:PipelineEvidence;
  selectedItemId: string | null;
  onSelectItem: (id: string) => void;
  onBack: () => void;
  onSelect: (id: string) => void;
  onEvidence: () => void;
  onInspectEvidence?: (id: string) => void;
  snapshotSelector: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const size = useStageSize(ref, FLOOR);
  const [evidenceTops,setEvidenceTops]=useState<Record<string,number>>({});
  const [evidenceHeight,setEvidenceHeight]=useState(0);
  const [mappingNoteHeight,setMappingNoteHeight]=useState(22);
  const [detailHeight,setDetailHeight]=useState(0);
  const evidenceLinks=itemEvidenceLinks(control);
  const candidateEvidence=pipelineControl?.evidence ?? [];
  const mappingReview=useStatementMappingReviews(candidateEvidence.length?observedRecord:undefined);
  const [reviewError,setReviewError]=useState("");
  const [reviewTarget,setReviewTarget]=useState<{statementId:string;evidenceId:string}|null>(null);
  const reviewed=(statementId:string,evidenceId:string)=>mappingReview.reviews.find(r=>r.controlId===control.id&&r.statementId===statementId&&r.evidenceId===evidenceId&&r.sourceSha256===observedRecord?.releaseSha256);
  const mappingKey=evidenceLinks.map(e=>`${e.statementId}:${e.evidenceId}`).join("|")+candidateEvidence.map(e=>e.id).join("|")+mappingReview.reviews.map(r=>r.id).join("|");
  const [wires, setWires] = useState<{ d: string; rel: string; to: string }[]>(
    [],
  );
  const links = directedLinksFor(pkg.map.edges, control.id);
  const items = pkg.map.statements[control.id]?.items ?? [];
  const paramIndex=pkg.map.statements[control.id]?.paramIndex??{};
  useEffect(()=>{if(items.length && !items.some(item=>item.id===selectedItemId)){const reviewedItem=items.find(item=>candidateEvidence.some(e=>reviewed(item.id,e.id)));onSelectItem((reviewedItem??items[0]).id);}},[control.id,selectedItemId,items,mappingKey]);
  const activeStatement=items.find(item=>item.id===selectedItemId)??items[0];
  const activeMappings=activeStatement?candidateEvidence.flatMap(e=>{const review=reviewed(activeStatement.id,e.id);return review?[{evidence:e,review}]:[];}):[];
  const hasReviewedPipelineLinks=candidateEvidence.some(e=>items.some(item=>reviewed(item.id,e.id)));
  const unreviewedPipelineItems=items.filter(item=>!candidateEvidence.some(e=>reviewed(item.id,e.id)));
  const unmappedItems=items.filter(item=>!evidenceLinks.some(e=>e.statementId===item.id)&&!candidateEvidence.some(e=>reviewed(item.id,e.id)));
  const enhancements =
    (observed || (Boolean(pipelineControl?.rollupReleaseId) && !pkg.map.byControl[control.id]?.requiredEnhancements?.length)) ? moderateControls().filter(c=>c.enhancement && c.id.startsWith(control.id+".")).map(c=>({id:c.id,label:`(${c.id.split(".").at(-1)})`,title:c.title})) : pkg.map.byControl[control.id]?.requiredEnhancements ?? [];
  const all = [
    ...links.mutual.map((l) => ({ ...l, mark: "⇄" })),
    ...links.outbound.map((l) => ({ ...l, mark: "→" })),
    ...links.reverse.map((l) => ({ ...l, mark: "←" })),
  ];
  const onMap = all.filter((l) => pkg.controls.some((c) => c.id === l.otherId));
  const offMap = all.filter(
    (l) => !pkg.controls.some((c) => c.id === l.otherId),
  );
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    const origin = root.getBoundingClientRect();
    const card = root
      .querySelector('[data-testid="level2-control"]')
      ?.getBoundingClientRect();
    if (!card) return;
    const x = card.right - origin.left,
      y = card.top - origin.top + card.height / 2;
    const rows=[...root.querySelectorAll<HTMLElement>("[data-item-id]")];
    const column=root.querySelector<HTMLElement>(".round21-item-column")?.getBoundingClientRect();
    const next:{d:string;rel:string;to:string}[]=[],tops:Record<string,number>={};
    let bottom=40;
    const fanTrunk=(x+Math.min(...rows.map(row=>row.getBoundingClientRect().left-origin.left)))/2;
    for(const row of rows) {
      const box=row.getBoundingClientRect(),center=box.top-origin.top+box.height/2,id=row.dataset.itemId!;
      next.push({rel:"statement-fan",to:id,d:treePath(busRoute({x,y},{x:box.left-origin.left,y:center},fanTrunk))});
      if(column) {
        const evidenceCard=root.querySelector<HTMLElement>(`[data-statement-evidence="${id}"]`);
        const height=evidenceCard?.getBoundingClientRect().height ?? 64;
        const top=Math.max(bottom,box.top-column.top);tops[id]=top;bottom=top+height+12;
        for(const artifact of evidenceCard?.querySelectorAll<HTMLElement>('[data-statement-artifact]')??[]) {
          const bounds=artifact.getBoundingClientRect();
          const mapped=artifact.dataset.mappingState==="reviewed";
          next.push({rel:mapped?"item-evidence":"unmapped-evidence",to:`evidence-${id}-${artifact.dataset.statementArtifact}`,d:treePath(busRoute({x:box.right-origin.left,y:center},{x:bounds.left-origin.left,y:bounds.top-origin.top+bounds.height/2},(box.right+column.left)/2-origin.left))});
        }
      }
    }
    const controlEvidence=root.querySelector(".round21-focus-evidence button")?.getBoundingClientRect();
    if(controlEvidence) {
      const from=items.length === 1 ? {x:card.right-origin.left,y:card.top-origin.top+card.height/2} : {x:card.left-origin.left+card.width/2,y:card.bottom-origin.top};
      const to=items.length === 1 ? {x:controlEvidence.left-origin.left,y:controlEvidence.top-origin.top+controlEvidence.height/2} : {x:from.x,y:controlEvidence.top-origin.top};
      next.push({rel:"control-evidence",to:"control-artifacts",d:treePath(busRoute(from,to,(from.x+to.x)/2))});
    }
    setEvidenceTops(tops);setEvidenceHeight(bottom);setDetailHeight(Math.ceil(root.querySelector(".round21-selected-detail")?.getBoundingClientRect().height??0));setWires(next);
  }, [control.id, size.width, size.height, items.length, mappingKey, evidenceHeight, selectedItemId]);
  const statementDetail=activeStatement && <section className={`round21-selected-detail${items.length===1?" selected-detail-wide":""}`} style={items.length===1 ? undefined : {top:evidenceHeight+mappingNoteHeight+12}} data-testid="selected-statement-detail" aria-label="Selected statement evidence and review details">
          <div><p className="l2-kicker">{selectedItemId?'Selected statement':'Statement detail'} · {activeStatement.label||activeStatement.id}</p>
            {activeStatement.params.length===0&&<p>No organization-defined parameters in this statement.</p>}{activeStatement.params.length>0&&<dl>{activeStatement.params.map(param=><React.Fragment key={param.paramId}><dt className="mono">{param.paramId}</dt><dd>{param.constraint?<>FedRAMP constraint · {param.constraint}</>:<>Organization-defined parameter · {param.label||param.paramId} · value not recorded</>}</dd></React.Fragment>)}</dl>}
            <small>Catalog requirement · {activeStatement.citation}.</small></div>
          <div><p className="l2-kicker">Retained evidence · {countLabel(candidateEvidence.length,'artifact')}</p><p>{candidateEvidence.map(e=>e.title).join(' · ')||'No retained artifact linked'}</p>{observedRecord&&<dl className="round21-source-proof"><dt>Source release</dt><dd className="mono">#{observedRecord.pipelineId}</dd><dt>Commit</dt><dd className="mono">{observedRecord.commitSha}</dd><dt>Receipt SHA256</dt><dd className="mono">{observedRecord.releaseSha256}</dd><dt>Captured</dt><dd>{utcTime(observedRecord.createdAt,true)}</dd></dl>}</div>
          <div><p className="l2-kicker">Review decision · {activeMappings.length?'reviewed':'not reviewed'}</p>{activeMappings.length?activeMappings.map(({evidence,review})=><div key={review.id}><strong>{evidence.title} · {review.reviewer}</strong><p>{review.basis}</p><small>{utcTime(review.reviewedAt,true)}</small></div>):<p>Inspect a candidate artifact, then use its Review action to record relevance and limitations for this statement.</p>}<small>Reviewing a mapping does not establish effectiveness, refresh evidence or close a finding.</small></div>
        </section>;
  const primary =
    pipelineControl?.evidence.find((e) => e.title === "configuration.json") ??
    pipelineControl?.evidence[0];
  const controlEvidence=primary ? (
            <section className="round21-focus-evidence">
              <span className="l2-kicker">Control-level evidence</span>
              <button onClick={()=>observed && onInspectEvidence ? onInspectEvidence(primary.id) : onEvidence()}>
                <strong className="mono">{observed ? pipelineControl?.evidence.map(e=><span key={e.id}>■ {e.title}</span>) : primary.title}</strong>
                <small>#{receiptLabel(pipelineControl?.rollupReleaseId??"")} · release</small>
              </button>

              <p>
                Supports {control.id} as a whole.{" "}
                {unreviewedPipelineItems.length ? `Not mapped to ${unreviewedPipelineItems.length === 1 ? "statement" : "statements"} ${unreviewedPipelineItems.map(i => i.label?.trim().replace(/\.$/, "") || i.id).join(", ")}.` : "Reviewed statement links are shown in the evidence column; effectiveness is separate."}
              </p>
            </section>
          ) : null;
  return (
    <div className={`round21-focus${observed ? " observed-focus" : ""}${items.length === 1 ? " single-statement" : ""}`} data-testid="level2-focus">
      <div className="round21-focus-bar">
        <button className="l2-back" data-testid="level2-back" onClick={onBack}>
          ← Map <kbd>Esc</kbd>
        </button>
        <nav className="l2-crumb" aria-label="Focus breadcrumb" data-testid="level2-breadcrumb">
          <button onClick={onBack}>Package map</button>
          <span>›</span>
          <b>{control.family}</b>
          <span>›</span>
          <strong className="mono">{control.id}</strong>
        </nav>
        <span className="l2-badge">Level 2 · focus</span>
        {snapshotSelector}
      </div>
      <div className="round21-focus-board" ref={ref}>
        <svg
          className="round21-focus-wires"
          width={size.width}
          height={Math.max(size.height,evidenceHeight)}
          aria-hidden="true"
        >
          {wires.map((w) => (
            <path
              key={w.to}
              data-rel={w.rel}
              data-from={control.id}
              data-to={w.to}
              d={w.d}
              fill="none"
              stroke={w.rel === "statement-fan" ? "#b9aefc" : "#3b7fc4"}
              strokeDasharray={w.rel === "unmapped-evidence" ? "3 4" : undefined}
              strokeWidth="1.3"
            />
          ))}
        </svg>
        <div className="round21-focus-rail">
          <section className="round21-related" data-testid="level2-links">
            <span className="l2-kicker">Related · directed</span>
            {onMap.map((l) => {
              const c = pkg.controls.find((c) => c.id === l.otherId)!;
              const [a, b] = faceLines(c.id, c.title);
              return (
                <button
                  key={l.otherId}
                  title={`${l.mark} ${c.id} ${c.title}`}
                  data-testid={`related-${l.otherId}`}
                  onClick={() => onSelect(l.otherId)}
                >
                  <i>{l.mark}</i>
                  <strong
                    className={`mono${pipelineControl && Boolean(c.rollupReleaseId) ? " release-id" : ""}`}
                  >
                    {c.id}
                  </strong>
                  <span title={c.title}>
                    {a} {b}
                  </span>
                </button>
              );
            })}
            {offMap.length > 0 && (
              <details>
                <summary>{offMap.length} links outside this map</summary>
                {offMap.map((l) => (
                  <button key={l.otherId} onClick={() => onSelect(l.otherId)}>
                    {l.mark} {l.otherId}
                  </button>
                ))}
              </details>
            )}
          </section>
          <article
            className={`round21-focus-control${pipelineControl?.rollupState === "recorded" ? " linked" : ""}`}
            data-testid="level2-control"
          >
            <span className="mono">{control.id}</span>
            <strong>{control.title}</strong>
            <small>
              {control.family} ·{" "}
              {pkg.map.families.find((f) => f.id === control.family)?.title}
            </small>
            <small>Role · {control.responsibleRole || "no role"}</small>
            <b className={observed || control.complete ? "good" : "bad"}>
              {observed ? `● Control-level evidence · ${countLabel(pipelineControl?.evidence.length??0,"artifact")}` : controlFaceStatus(control)}
            </b>
            <small data-testid="level2-item-coverage">{observed ? "Statement coverage is separate." : pipelineControl?.rollupReleaseId ? `Recorded control-level evidence · #${pipelineControl.rollupReleaseId}. Statement coverage is separate.` : "No release evidence selected. Statement coverage is separate."}</small>
          </article>
          {(items.length === 0 || (unmappedItems.length === 0 && !hasReviewedPipelineLinks)) && controlEvidence}
        <section
          className="round21-focus-enhancements"
          data-testid="focus-enhancements"
        >
          <span className="l2-kicker">
            Required enhancement · {enhancements.length}
          </span>
          {observed ? <div className="observed-enhancement-list"><strong>{enhancements.length} enhancements</strong>{enhancements.map(e=><div key={e.id}><button type="button" title={e.title} onClick={()=>onSelect(e.id)}>{e.label}</button><span>{e.title}</span></div>)}<small>Blank · not assessed</small></div> : enhancements.map((e) => (
            <div key={e.id}>
              <b className="mono">{e.label}</b> {e.title}
              <span>Blank</span>
            </div>
          ))}
          <p>FedRAMP Moderate · not in subset</p>
        </section>
        </div>
        <div className="round21-focus-statements">
          <p className="l2-kicker">
            Statement · {items.length} {items.length === 1 ? "item" : "items"} · 800-53 Rev{" "}
            {pkg.map.catalogVersion ?? "5.2.0"}
          </p>
          <ol className="l2-rows">
            {items.map((item) => (
              <React.Fragment key={item.id}><StatementRow
                key={item.id}
                item={item}
                addressed={statementAddressed(control, item.id)}
                selected={item.id === selectedItemId}
                onSelect={() => onSelectItem(item.id)}
                releaseOnly
                evidenceLabel={candidateEvidence.some(e=>reviewed(item.id,e.id)) ? countLabel(candidateEvidence.filter(e=>reviewed(item.id,e.id)).length,"reviewed artifact link") : evidenceLinks.some(e=>e.statementId===item.id) ? "Item-level evidence linked" : undefined}
              />{item.objectives.length>0 && <li className="round21-statement-objectives"><details open={items.length===1||item.id===selectedItemId} data-testid="level2-assessment-objectives"><summary className="l2-kicker">Assessment objective · 800-53A · {item.objectiveCount}</summary>{item.objectives.map(objective=><p key={objective.id}><strong className="mono" title={objective.id}>{objective.label || objective.id}</strong> {resolvedStatementProse(objective.prose,paramIndex)}</p>)}<small>Catalog requirement · statement evidence mapping needs review.</small></details></li>}</React.Fragment>
            ))}
          </ol>
          {items.length===1 && observedRecord?.schema==="aegis.evidence-event.v1" && <section className="round21-scope-card"><p className="l2-kicker">Observed check scope · control level</p>{observedRecord.observation.checks.filter(c=>observationControl(c)===control.id).map(c=><div key={c.id}><strong className="mono">{c.id}</strong><p>{c.requirement.objective}</p><small>Captured {c.verdict.toUpperCase()} · {utcTime(observedRecord.createdAt,true)}</small></div>)}<p><strong>Assessed subject</strong><br/>{observedRecord.observation.subject.id}</p><small>Producer-declared scope · does not establish statement coverage.</small></section>}
          {items.length===1 && statementDetail}
        </div>
        <section className="round21-item-column" aria-label="Statement evidence mapping" style={{minHeight:evidenceHeight+mappingNoteHeight+(items.length===1?0:detailHeight)+24}}>
          <p className="l2-kicker">Evidence · mapping status{!evidenceLinks.length && !candidateEvidence.some(e=>items.some(item=>reviewed(item.id,e.id))) && <small className="round21-review-state">No reviewed statement mappings</small>}</p>
          {mappingReview.error&&<p className="round21-review-state" role="status">{mappingReview.error}</p>}
          {items.map(item=>{
            const mapped=evidenceLinks.filter(e=>e.statementId===item.id).map(e=>control.evidence.find(a=>a.id===e.evidenceId)).filter(e=>e!==undefined);
            return <div key={item.id} data-statement-evidence={item.id} className={`round21-item-card ${mapped.length || candidateEvidence.some(e=>reviewed(item.id,e.id)) ? "mapped" : "blank"}`} style={{top:evidenceTops[item.id]??40}}>
              <strong className="mono">{item.label?.trim() || item.id}</strong>
              {mapped.length>0 && <><small>SSP evidence · package-declared links</small>{mapped.map(e=><button data-statement-artifact={e.id} data-evidence-origin="ssp" data-mapping-state="reviewed" type="button" key={e.id} onClick={onEvidence}>{e.title} ↗</button>)}</>}
              {candidateEvidence.length>0 && <><small>Retained observation · #{receiptLabel(pipelineControl?.rollupReleaseId??"")}</small>{candidateEvidence.map(e=>{
                const decision=reviewed(item.id,e.id);
                return <div className="round21-artifact-review" key={e.id} data-statement-artifact={e.id} data-evidence-origin="observation" data-mapping-state={decision?"reviewed":"unreviewed"}>
                  <button type="button" className="round21-candidate-artifact" onClick={()=>onInspectEvidence ? onInspectEvidence(e.id) : onEvidence()}><strong>{e.title} ↗</strong>{items.length===1&&observedRecord&&<small>Captured {utcTime(observedRecord.createdAt,true)}</small>}{observedRecord?.schema==="aegis.evidence-event.v1"&&observedRecord.observation.artifactDigests.filter(a=>a.name===e.title).map(a=><code key={a.name} title={a.sha256}>SHA256 {receiptLabel(a.sha256)}</code>)}</button>
                  {decision ? <><small className="reviewed-mapping">Mapping reviewed · {decision.reviewer}</small><details><summary>Review details</summary><p>{decision.basis}</p><small>{utcTime(decision.reviewedAt,true)}</small></details><button type="button" className="round21-review-action" onClick={()=>void mappingReview.save({controlId:control.id,statementId:item.id,evidenceId:e.id,reviewer:decision.reviewer,basis:decision.basis},'reopen').catch(cause=>setReviewError(String(cause instanceof Error?cause.message:cause)))}>Reopen mapping</button></> : <><small title="Statement mapping unreviewed">Unreviewed</small><button type="button" className="round21-review-action" disabled={mappingReview.loading||Boolean(mappingReview.error)} aria-label={`Review mapping from ${e.title} to ${item.id}`} onClick={()=>setReviewTarget({statementId:item.id,evidenceId:e.id})}>Review</button></>}
                </div>;
              })}</>}
              {!mapped.length && !candidateEvidence.length && <span>No item-level evidence linked.</span>}
            </div>;
          })}
          {candidateEvidence.length>0 && unmappedItems.length>0 && <details className="round21-mapping-note" style={{top:evidenceHeight}} onToggle={event=>setMappingNoteHeight(Math.ceil(event.currentTarget.getBoundingClientRect().height))}><summary>Statement mapping details</summary><p>No item-level evidence linked for {unmappedItems.map(i=>i.label?.trim().replace(/\.$/, "") || i.id).join(", ")}. Supports {control.id} as a whole. Not mapped to {unmappedItems.length===1?"statement":"statements"} {unmappedItems.map(i=>i.label?.trim().replace(/\.$/, "") || i.id).join(", ")}. Candidate statement mappings need review. Reviewing a link does not assess control effectiveness.</p></details>}


          {items.length!==1 && statementDetail}

        </section>


      </div>
      {reviewError&&<p role="alert" className="pipeline-error">{reviewError}</p>}
      {reviewTarget&&observedRecord&&candidateEvidence.some(e=>e.id===reviewTarget.evidenceId)&&<StatementMappingDialog controlId={control.id} statementId={reviewTarget.statementId} statementProse={resolvedStatementProse(items.find(i=>i.id===reviewTarget.statementId)?.prose??"",paramIndex)} evidence={candidateEvidence.find(e=>e.id===reviewTarget.evidenceId)!} source={observedRecord} onClose={()=>setReviewTarget(null)} onSave={(reviewer,basis)=>mappingReview.save({controlId:control.id,...reviewTarget,reviewer,basis},'review')}/>}
      <div className="round21-focus-legend">
        <span>■ release evidence · control level</span>
        <span>⇄ both list each other</span>
        <span>→ one-way related</span>
        <span>○ not addressed</span><span>Dashed evidence link = statement mapping needs review</span>
        <span>teal id = linked by release</span>
      </div>
    </div>
  );
}
