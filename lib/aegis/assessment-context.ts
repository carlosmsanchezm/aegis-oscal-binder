import {validateSchema} from "../oscal/validate-schema";
import { readFileSync } from "node:fs";
import path from "node:path";
import Ajv, { type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import { findRepoRoot } from "./paths";
import { internalSystemId, OSCAL_VERSION, REMEDIATION_NAMESPACE, stableUuid } from "./poam";
import type { RemediationPlan } from "./remediation";

type Document = Record<string, any>;
const contextRemark = "Internal scoped assessment context reconstructed from the saved requirement and workload. Not evidence of a pre-approved test plan. Not an agency-approved plan, authoritative NIST baseline, full system SSP, authorization boundary or control-compliance assertion. Agency categorization and approval are not inferred.";
const property = (name:string,value:string) => ({name,value,ns:REMEDIATION_NAMESPACE});
export function validateContextDocument(document:unknown,model:"assessment-plan"|"system-security-plan"|"catalog",root=findRepoRoot()):string[]{
 const result=validateSchema(document,model,root);return result.errors.slice(0,8).map(e=>`${model}${e.instancePath}: ${e.message}`);
}

/** Self-contained internal context. Every requirement is authored on the saved scoped record. */
export function buildAssessmentContext(plan:RemediationPlan,now:Date) {
  const scope=plan.assessment.scope!;
  const metadata=(title:string)=>({title,"last-modified":now.toISOString(),version:"0.1.0","oscal-version":OSCAL_VERSION,
    props:[property("export-purpose","internal-scoped-context"),property("plan-origin","retrospective-from-saved-assessment"),property("agency-approved","false"),property("illustrative-assessment",String(plan.assessment.illustrative)),property("scope-reviewer",plan.assessment.reviewer.replace(/\s+/g," ")),property("scope-date",plan.assessment.date)],remarks:contextRemark});
  const controls=[...new Set(scope.controls.map(id=>`aegis-context-${id.toLowerCase()}`))];
  const controlId=`aegis-context-${plan.control.toLowerCase()}`;
  const objectiveId=`aegis-objective-${stableUuid(JSON.stringify([scope.asset,controlId,plan.assessment.requirement]))}`;
  const assetUuid=stableUuid(`${internalSystemId(plan).id}:asset`);
  const catalogUuid=stableUuid(`${plan.id}:internal-context-catalog`);
  const sspUuid=stableUuid(`${plan.id}:internal-context-ssp`);
  const apUuid=stableUuid(`${plan.id}:assessment-plan`);
  const catalogResourceUuid=stableUuid(`${plan.id}:internal-context-catalog-resource`);
  const sspResourceUuid=stableUuid(`${plan.id}:internal-context-ssp-resource`);
  const apResourceUuid=stableUuid(`${plan.id}:assessment-plan-resource`);
  const resource=(uuid:string,title:string,filename:string,document:Document)=>({uuid,title,
    props:[property("context-origin","generated-from-saved-scope"),property("agency-approved","false")],
    base64:{filename,"media-type":"application/oscal+json",value:Buffer.from(JSON.stringify(document),"utf8").toString("base64")}});
  const catalog:Document={catalog:{uuid:catalogUuid,metadata:metadata("Internal scoped requirement catalog"),
    controls:controls.map(id=>({id,title:`Internal mapping context: ${scope.controls.find(c=>`aegis-context-${c.toLowerCase()}`===id)}`,
      props:[property("source-control-reference",scope.controls.find(c=>`aegis-context-${c.toLowerCase()}`===id)!),property("source-framework",scope.framework.replace(/\s+/g," ")),property("source-policy-reference",scope.baseline.replace(/\s+/g," "))],
      parts:[{id:`${id}_smt`,name:"statement",prose:plan.assessment.requirement}]}))}};
  const ssp:Document={"system-security-plan":{uuid:sspUuid,metadata:metadata(`Internal scoped workload: ${scope.asset}`),
    "import-profile":{href:`#${catalogResourceUuid}`,remarks:"Internal scoped catalog; not the referenced agency or FedRAMP baseline."},
    "system-characteristics":{"system-ids":[internalSystemId(plan)],"system-name":scope.asset,description:contextRemark,
      "system-information":{"information-types":[{title:"Internal assessment records",description:"Saved scoped requirement and release/evidence references. No agency information-type categorization is asserted."}]},
      status:{state:"other",remarks:"Operational and authorization status are not established by this scoped context."},
      "authorization-boundary":{description:`Internal assessment subject: ${scope.asset}. No Government authorization boundary is asserted.`}},
    "system-implementation":{users:[{uuid:stableUuid(`${sspUuid}:reviewer-context`),title:"Internal review context",remarks:"Context entry only; no account, assignment or access privilege is asserted."}],
      components:[{uuid:assetUuid,type:"system",title:scope.asset,description:"Workload identified by the saved scope; no full architecture or control implementation is inferred.",status:{state:"other"}}]},
    "control-implementation":{description:"Requirement mapping context only. Implementation and compliance are not asserted.",
      "implemented-requirements":controls.map(id=>({uuid:stableUuid(`${sspUuid}:${id}`),"control-id":id,remarks:"Context reference only; no implementation conclusion is recorded here."}))},
    "back-matter":{resources:[resource(catalogResourceUuid,"Internal scoped catalog","internal-scope-catalog.json",catalog)]}}};
  const reviewedControls={description:"Only the recorded scoped requirement is assessed; mapped controls are context, not full-control assessment.",
    "control-selections":[{"include-controls":controls.map(id=>({"control-id":id}))}],
    "control-objective-selections":[{"include-objectives":[{"objective-id":objectiveId}]}]};
  const ap:Document={"assessment-plan":{uuid:apUuid,metadata:metadata(`Internal assessment plan: ${scope.title}`),
    "import-ssp":{href:`#${sspResourceUuid}`,remarks:"Attached internal scoped workload context; not an agency system SSP."},
    "local-definitions":{"objectives-and-methods":[{"control-id":controlId,description:"Assessment-specific objective defined by the saved applicable requirement, not a NIST objective ID.",parts:[
      {id:objectiveId,name:"assessment-objective",prose:plan.assessment.requirement,props:[{name:"method-id",value:`${objectiveId}-examine`},{name:"method-id",value:`${objectiveId}-test`}]},
      {id:`${objectiveId}-examine`,name:"assessment-method",props:[{name:"method",ns:"http://csrc.nist.gov/ns/rmf",value:"EXAMINE"}],parts:[{name:"assessment-objects",prose:`Selected source artifacts: ${scope.artifacts.join(", ")}.`}]},
      {id:`${objectiveId}-test`,name:"assessment-method",props:[{name:"method",ns:"http://csrc.nist.gov/ns/rmf",value:"TEST"}],parts:[{name:"assessment-objects",prose:scope.verification.join("\n\n")}]},
    ]}]},
    "reviewed-controls":reviewedControls,
    "assessment-subjects":[{type:"component","include-subjects":[{"subject-uuid":assetUuid,type:"component"}]}],
    "terms-and-conditions":{parts:[{name:"scope",ns:REMEDIATION_NAMESPACE,prose:`Assess only: ${plan.assessment.requirement}. Outside scope: ${scope.remainingScope.join("; ")||"Other controls and system authorization"}.`}]},
    "back-matter":{resources:[resource(sspResourceUuid,"Internal scoped workload context","internal-scope-ssp.json",ssp)]}}};
  for (const [doc,model] of [[catalog,"catalog"],[ssp,"system-security-plan"],[ap,"assessment-plan"]] as const) {
    const errors=validateContextDocument(doc,model);
    if (errors.length) throw new Error(`Invalid internal assessment context: ${errors.join("; ")}`);
  }
  return {document:ap,resource:resource(apResourceUuid,"Internal scoped assessment plan","assessment-plan.json",ap),objectiveId,controlId,reviewedControls};
}

/** Resolve attached OSCAL documents; no network requests or trust in a title-only placeholder. */
export function resolveContextDocument(parent:Document,href:string,model:string):Document {
  if (!/^#[0-9a-f-]{36}$/.test(href)) throw new Error(`Expected an attached ${model} reference.`);
  const resources=parent["back-matter"]?.resources;
  const matches=Array.isArray(resources) ? resources.filter((r:Document)=>`#${r.uuid}`===href) : [];
  if (matches.length!==1 || !["application/json","application/oscal+json"].includes(matches[0].base64?.["media-type"])) throw new Error(`Missing attached ${model} content.`);
  const encoded=matches[0].base64.value;
  if (typeof encoded!=="string" || encoded.length>1_000_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error(`Invalid attached ${model} content.`);
  const doc=JSON.parse(Buffer.from(encoded,"base64").toString("utf8"));
  if (!doc?.[model]) throw new Error(`Attached content is not ${model}.`);
  return doc;
}
