import type {PipelineEvidence} from "./pipeline-evidence";
import {releaseSystemName} from "./system-name";
import type {EvidenceConnection} from "./connected-evidence";

export type EvidenceSourceLabel="recorded example"|"received pipeline"|"captured reference"|"uploaded package";
/** Provenance is appended once; source-owned identity is never rewritten for a snapshot. */
export function workspaceSystemLabel(name:string,source:EvidenceSourceLabel):string {
 const identity=name.replace(/\s+·\s+(recorded(?: example)?|received pipeline|captured reference|uploaded package)$/i,"").trim();
 const label=identity ? identity.charAt(0).toUpperCase()+identity.slice(1) : "Unnamed system";
 return `${label} · ${source}`;
}
export function pipelineSystemName(record:PipelineEvidence):string {
 return record.schema==="aegis.evidence-event.v1" ? record.observation.systemName : record.systemName ?? releaseSystemName([record]);
}
export function connectionSystemLabel(connection:EvidenceConnection):string {
 const source=/·\s*captured reference$/i.test(connection.name) ? 'captured reference' : connection.history.some(item=>item.authentication==='connection-token') ? 'received pipeline' : 'uploaded package';
 return workspaceSystemLabel(connection.name,source);
}
