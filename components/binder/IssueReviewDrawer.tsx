"use client";
import React,{useState} from "react";
import {createPortal} from "react-dom";
import {useDialogFocus} from "./useDialogFocus";
import type {PipelineEvidence} from "@/lib/aegis/pipeline-evidence";
import type {ReviewObservation} from "@/lib/aegis/review-context";
import {usePlanProposals} from "./PlanProposal";
import type {PlanProposal} from "@/lib/aegis/plan-proposal";
export function IssueReviewDrawer({record,issue,action,onClose,onDraft}:{record:PipelineEvidence;issue:ReviewObservation|undefined;action:"triage"|"draft";onClose:()=>void;onDraft:(p:PlanProposal)=>void}){
 const workspace=usePlanProposals();
 const ref=useDialogFocus(onClose),[outcome,setOutcome]=useState("fix-now"),[reason,setReason]=useState(""),[busy,setBusy]=useState(false),[error,setError]=useState(""),[saved,setSaved]=useState<string|null>(null);
 async function submit(){
  if(record.schema!=="aegis.evidence-event.v1"||!issue){setError("This action needs a retained scanner finding in the selected workspace.");return;}
  setBusy(true);setError("");
  try{const response=await fetch("/api/remediation/issues",{method:"POST",headers:{...workspace?.headers,"content-type":"application/json"},body:JSON.stringify({action,connectionId:record.observation.connectionId,receiptId:record.releaseSha256,issueId:issue.id,outcome,reason})});const result=await response.json();if(!response.ok||!result.ok)throw new Error(result.error??"Issue action unavailable.");if(action==="draft"){onDraft(result.proposal);return;}setSaved(`Triage recorded by ${result.decision.actor} at ${result.decision.at}`);}catch(cause){setError(cause instanceof Error?cause.message:"Issue action unavailable.");}finally{setBusy(false);}
 }
 return createPortal(<div className="rem-overlay"><section ref={ref} tabIndex={-1} className="rem-drawer rem-draft-drawer poam-view proposal-drawer" role="dialog" aria-modal="true" aria-labelledby="issue-action-title"><header><h2 id="issue-action-title">{action==="draft"?"Plan of action":"Triage"}</h2><span>Proposed review</span><button type="button" onClick={onClose} aria-label="Close issue review">×</button></header><div className="rem-drawer-body"><section className="proposal-section"><h3>What is wrong</h3><p>{issue?.description??"Select a retained scanner finding to continue."}</p>{action==="triage"?<><label className="rem-field"><span>Outcome</span><select aria-label="Triage outcome" value={outcome} onChange={e=>setOutcome(e.target.value)}><option value="fix-now">Fix now</option><option value="plan-it">Plan it</option></select></label><label className="rem-field"><span>Reason</span><textarea aria-label="Triage reason" value={reason} maxLength={4000} onChange={e=>setReason(e.target.value)}/></label></>:<p>Draft a proposed action from this scanner finding and its pinned source. A person reviews the draft before acceptance.</p>}{error&&<p role="alert">{error}</p>}{saved&&<p role="status">{saved}</p>}<button className="btn primary" type="button" disabled={busy||!!saved||(action==="triage"&&!reason.trim())} onClick={()=>void submit()}>{busy?"Working…":action==="draft"?"Draft plan":"Record triage"}</button></section></div></section></div>,document.body);
}
