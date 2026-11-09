/** A person's evidence-to-statement review, separate from control effectiveness and package gates. */
export type StatementMappingReview={
 id:string;controlId:string;statementId:string;evidenceId:string;sourceReleaseId:string;sourceSha256:string;
 reviewer:string;basis:string;reviewedAt:string;
};
export function normalizeStatementMapping(value:unknown):StatementMappingReview|null{
 if(!value||typeof value!=="object"||Array.isArray(value))return null;
 const v=value as StatementMappingReview;
 if(!/^[a-f0-9]{64}$/.test(v.id)||!/^[A-Z]{2}-\d+(?:\.\d+)?$/.test(v.controlId)||!/^[a-f0-9]{64}$/.test(v.sourceSha256))return null;
 for(const [key,max] of [["statementId",200],["evidenceId",1000],["sourceReleaseId",200],["reviewer",80],["basis",2000],["reviewedAt",40]] as const)if(typeof v[key]!=="string"||!v[key].trim()||v[key].length>max)return null;
 if(!Number.isFinite(Date.parse(v.reviewedAt)))return null;
 return {id:v.id,controlId:v.controlId,statementId:v.statementId,evidenceId:v.evidenceId,sourceReleaseId:v.sourceReleaseId,sourceSha256:v.sourceSha256,reviewer:v.reviewer.trim(),basis:v.basis.trim(),reviewedAt:v.reviewedAt};
}
export const STATEMENT_MAPPING_KEY="binder.statement-mappings.v1";
