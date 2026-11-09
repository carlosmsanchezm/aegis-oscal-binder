import type {WorkflowState} from "./gates/types";
/** Measurement changes do not advance human review gates. */
export function gateIssueState(state:WorkflowState){return {readyToClose:state==="ready-for-closure-review",closureConfirmed:state==="closed-externally"};}
