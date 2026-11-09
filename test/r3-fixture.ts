// Explicit synthetic interaction fixtures. These are never imported by production code.
import {CCM_EXAMPLE} from "../lib/aegis/pipeline-evidence";
import {evidenceByControl} from "../lib/collector/control-evidence";
import {moderateControls} from "../lib/aegis/moderate-baseline";
import type {EvidenceControl,EvidenceFile} from "../lib/aegis/evidence-graph";
export const ids=moderateControls().map(c=>c.id);
export const index=evidenceByControl([CCM_EXAMPLE],ids);
export function graphFixture():EvidenceControl[]{const base=index.files[0];const file=(i:number):EvidenceFile=>({...base,key:`fixture-${i}`,name:`src/service/file-${i}.json`,collected:undefined});return [{id:"AC-2",evidence:[file(0)],suggested:[]},{id:"CM-6",evidence:[file(1)],suggested:Array.from({length:10},(_,i)=>file(i+2))}];}
export const observation={id:"fixture-issue",description:"Synthetic scanner finding",scope:{title:"Synthetic configuration finding",asset:"frontend",controls:["CM-6"],framework:"NIST SP 800-53 Rev 5",baseline:"Synthetic test fixture",artifacts:["configuration.json"],verification:["Collect a fresh retest"],remainingScope:[]}};
