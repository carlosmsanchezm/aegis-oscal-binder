import {evidenceByControl,evidenceInventoryRecords} from "../collector/control-evidence";
import type {PipelineEvidence} from "./pipeline-evidence";
import {accountScanSummary} from "../collector/aws/summary";
/** Uses the shared collector index, including suggested and accepted mappings. */
export function mapEvidenceFiles(record:PipelineEvidence,history:PipelineEvidence[],controlIds:string[]){
 const onMap=new Set(controlIds);
 const files=evidenceByControl(evidenceInventoryRecords(record,history),controlIds).files.flatMap(file=>{
  const controls=[...new Set([...file.linked,...file.approved,...file.proposed])].filter(id=>onMap.has(id));
  const inventory=Boolean(accountScanSummary(file.collected));
  return controls.length||inventory?[{...file,controlIds:controls,inventory}]:[];
 });
 const latest=new Map<string,typeof files[number]>();
 for(const file of files){
  const source=file.collected?.source;if(source?.kind!=="aws-account")continue;
  const summary=accountScanSummary(file.collected);
  const key=summary?`summary:${summary.key}`:JSON.stringify([source.partition,source.account,source.region,source.path]);
  const old=latest.get(key);if(!old||Date.parse(file.capturedAt)>Date.parse(old.capturedAt))latest.set(key,file);
 }
 return files.filter(file=>{const source=file.collected?.source;if(source?.kind!=="aws-account")return true;const summary=accountScanSummary(file.collected);const key=summary?`summary:${summary.key}`:JSON.stringify([source.partition,source.account,source.region,source.path]);return latest.get(key)===file;});
}
