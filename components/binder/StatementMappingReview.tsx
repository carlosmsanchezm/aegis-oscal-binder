"use client";
import {createPortal} from "react-dom";
import {evidenceViewerHref} from "@/lib/builder/evidence-links";
import {useEffect,useRef,useState} from "react";
import {usePlanProposals} from "./PlanProposal";
import {useDialogFocus} from "./useDialogFocus";
import {normalizeStatementMapping,type StatementMappingReview} from "@/lib/aegis/statement-mapping";
import type {EvidenceView} from "@/lib/aegis/types";
import {receiptLabel,utcTime,requestMessage} from "@/lib/builder/presentation";
import type {PipelineEvidence} from "@/lib/aegis/pipeline-evidence";
export function useStatementMappingReviews(source?:PipelineEvidence){
 const headers=usePlanProposals()?.headers;
 const [reviews,setReviews]=useState<StatementMappingReview[]>([]),[loading,setLoading]=useState(true),[error,setError]=useState("");
 const scope=useRef("");
 useEffect(()=>{const abort=new AbortController();setReviews([]);scope.current="";setLoading(true);setError("");
  if(!source){setLoading(false);return;}
  void(async()=>{try{const response=await fetch('/api/statement-mappings',{headers,cache:'no-store',signal:abort.signal});if(!response.ok)throw new Error('Statement reviews could not be loaded. Reload before reviewing.');const body=await response.json();if(abort.signal.aborted)return;scope.current=body.sessionScope;setReviews((body.reviews??[]).flatMap((v:unknown)=>{const r=normalizeStatementMapping(v);return r?[r]:[];}));}catch(cause){if(!abort.signal.aborted)setError(requestMessage(cause,'Statement reviews are temporarily unavailable.'));}finally{if(!abort.signal.aborted)setLoading(false);}})();return()=>abort.abort();
 },[source?.releaseSha256,headers]);
 async function save(value:{controlId:string;statementId:string;evidenceId:string;reviewer:string;basis:string},action:'review'|'reopen'){
  if(!source||!scope.current)throw new Error('Reload before reviewing this mapping.');
  const expectedScope=scope.current;
  const job=async()=>{
    const response=await fetch('/api/statement-mappings',{method:'POST',headers:{...headers,'content-type':'application/json','x-aegis-expected-session':expectedScope},body:JSON.stringify({...value,sourceReleaseId:source.pipelineId,sourceSha256:source.releaseSha256,action})});
    const body=await response.json();if(!response.ok)throw new Error(body.error?.message??'This mapping could not be saved.');
    setReviews((body.reviews??[]).flatMap((v:unknown)=>{const r=normalizeStatementMapping(v);return r?[r]:[];}));
  };
  if(typeof navigator!=="undefined"&&navigator.locks)await navigator.locks.request('aegis-statement-mapping-save',job);else await job();
 }
 return {reviews,loading,error,save};
}
export function StatementMappingDialog({controlId,statementId,statementProse,evidence,source,onSave,onClose}:{controlId:string;statementId:string;statementProse:string;evidence:EvidenceView;source:PipelineEvidence;onSave:(reviewer:string,basis:string)=>Promise<void>;onClose:()=>void}){
 const ref=useDialogFocus(onClose),[reviewer,setReviewer]=useState(''),[basis,setBasis]=useState(''),[saving,setSaving]=useState(false),[error,setError]=useState('');
 async function submit(){setSaving(true);setError('');try{await onSave(reviewer.trim(),basis.trim());onClose();}catch(cause){setError(requestMessage(cause,'This review could not be saved.'));}finally{setSaving(false);}}
 return createPortal(<div className="rem-overlay"><section ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="statement-review-title" data-testid="statement-mapping-review" className="rem-drawer proposal-drawer statement-review-drawer"><header><h2 id="statement-review-title">Review statement mapping</h2><button type="button" className="icon-btn" onClick={onClose} aria-label="Close statement review">×</button></header><div className="rem-drawer-body"><section className="proposal-section"><span className="l2-kicker">{controlId} · {statementId}</span><p>{statementProse}</p><strong className="mono">{evidence.title}</strong><p>Source #{receiptLabel(source.pipelineId)} · captured {utcTime(source.createdAt,true)}</p><a href={evidenceViewerHref(evidence.href)} target="_blank" rel="noreferrer">Inspect original artifact ↗</a><p className="rem-muted">Review this artifact's relevance to the statement. A reviewed mapping does not establish control effectiveness, freshness, completeness or authorization.</p></section><section className="proposal-section"><label className="rem-field"><span>Reviewer</span><input value={reviewer} onChange={e=>setReviewer(e.target.value)} maxLength={80} autoComplete="off" /></label><label className="rem-field"><span>Review rationale</span><textarea value={basis} onChange={e=>setBasis(e.target.value)} rows={5} maxLength={2000}/><small>Record what this artifact demonstrates for this statement and any scope limitations.</small></label></section>{error&&<p role="alert" className="pipeline-error">{error}</p>}</div><footer><button type="button" className="btn ghost" onClick={onClose} disabled={saving}>Cancel</button><button type="button" className="btn primary" onClick={()=>void submit()} disabled={saving||!reviewer.trim()||!basis.trim()}>{saving?'Saving review…':'Mark mapping reviewed'}</button></footer></section></div>,document.body);
}
