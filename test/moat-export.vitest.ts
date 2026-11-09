import {connectionRecords} from "../lib/agent/service";
import {createAgentToken} from "../lib/agent/agent-token";
import {issueDraft} from "../lib/aegis/issue-actions";
import {decisionFromProposal} from "../lib/aegis/plan-proposal";
import {writeRemediationRecord} from "../lib/aegis/remediation-store";
import {releaseProject} from "../lib/aegis/control-rollup";
import {it,expect} from "vitest";
import {generateKeyPairSync} from "node:crypto";
import {mkdtempSync,readFileSync,rmSync,writeFileSync,readdirSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import {zipSync,strToU8} from "fflate";
import {validateSchema,assertSchema,OSCAL_MODELS} from "../lib/oscal/validate-schema";
import {createManifest,verifyManifest,type BundleFile} from "../lib/manifest/manifest";
import {makeBundle,readBundleZip,writeBundleDirectory,verifyBundlePath} from "../lib/manifest/bundle";
import {buildBinderDocuments} from "../lib/aegis/baseline-binder";
import {createConnection,retainEvent} from "../lib/server/builder-store";
import {summarizeBuilderBundle} from "../lib/server/builder-observation";
import {connectedReleases} from "../lib/aegis/connected-evidence";
import {exportConnectionBundle} from "../lib/oscal/connection-export";
import {POST as verifyPost} from "../app/api/oscal/verify/route";
import original from "../fixtures/boutique-live/40446239616/event.json";
import retest from "../fixtures/boutique-live/40446815397/event.json";
import pins from "../schemas/oscal/1.1.2/checksums.json";
import {sha256} from "../lib/manifest/manifest";
const uuid="cfc0be96-e260-4e9f-996f-cfb62c934944",metadata={title:"Recorded schema test",version:"1","oscal-version":"1.1.2","last-modified":"2026-10-27T04:00:00Z"};
function testKeys(){const pair=generateKeyPairSync("ed25519");return {privateKey:Buffer.from(pair.privateKey.export({type:"pkcs8",format:"pem"})).toString("base64"),publicKey:Buffer.from(pair.publicKey.export({type:"spki",format:"pem"})).toString("base64")};}
function signing<T>(fn:()=>T){const old=[process.env.AEGIS_MANIFEST_SIGNING_KEY,process.env.AEGIS_MANIFEST_PUBLIC_KEY],keys=testKeys();process.env.AEGIS_MANIFEST_SIGNING_KEY=keys.privateKey;process.env.AEGIS_MANIFEST_PUBLIC_KEY=keys.publicKey;try{return fn();}finally{if(old[0]===undefined)delete process.env.AEGIS_MANIFEST_SIGNING_KEY;else process.env.AEGIS_MANIFEST_SIGNING_KEY=old[0];if(old[1]===undefined)delete process.env.AEGIS_MANIFEST_PUBLIC_KEY;else process.env.AEGIS_MANIFEST_PUBLIC_KEY=old[1];}}
const files:BundleFile[]=[{path:"evidence/collected.json",mediaType:"application/json",bytes:Buffer.from('{"recorded":true}')}];
it("official release schema bytes match all seven published pins",()=>{expect(pins.files).toHaveLength(7);for(const row of pins.files)expect(sha256(readFileSync(path.join("schemas/oscal/1.1.2",row.file)))).toBe(row.sha256);});
it("all seven OSCAL models accept valid recorded/minimal context and reject broken documents",async()=>{
 const old=process.env.AEGIS_DATA_DIR,folder=mkdtempSync(path.join(os.tmpdir(),"moat-models-"));process.env.AEGIS_DATA_DIR=folder;
 try{
  const c=await createConnection("Recorded schema test"),bundle=await retainEvent(c.connection.id,JSON.stringify(original));
  const release=connectedReleases({...c.connection,revokedAt:null,history:[summarizeBuilderBundle(bundle)]},"http://localhost");
  const docs=buildBinderDocuments(release,null,new Date("2026-10-27T04:00:00Z"));
  // Existing binder context is self-contained in base64 resources.
  const ar=docs.assessmentResults["assessment-results"] as any;
  const ap=JSON.parse(Buffer.from(ar["back-matter"].resources[0].base64.value,"base64").toString("utf8"));
  const sspBody=docs.ssp["system-security-plan"] as any;
  const catalog=JSON.parse(Buffer.from(sspBody["back-matter"].resources[0].base64.value,"base64").toString("utf8"));
  const valid:Record<string,unknown>={"system-security-plan":docs.ssp,"assessment-results":docs.assessmentResults,"plan-of-action-and-milestones":{"plan-of-action-and-milestones":{uuid,metadata,"system-id":{id:"schema-fixture","identifier-type":"urn:aegis:test"},"poam-items":[{uuid,title:"Synthetic schema fixture only",description:"This fixture does not assert an accepted live plan."}]}},"assessment-plan":ap,catalog,profile:{profile:{uuid,metadata,imports:[{href:"catalog.json","include-all":{}}]}},"component-definition":{"component-definition":{uuid,metadata}}};
  for(const model of Object.keys(OSCAL_MODELS)){const result=validateSchema(valid[model]);expect(result.errors,model).toEqual([]);expect(validateSchema({[model]:{}}).valid,model).toBe(false);}
 }finally{if(old===undefined)delete process.env.AEGIS_DATA_DIR;else process.env.AEGIS_DATA_DIR=old;rmSync(folder,{recursive:true,force:true});}
});
it("sign/verify roundtrip, changed byte, missing/unmanifested member, wrong key and unsigned statuses",()=>{
 signing(()=>{const manifest=createManifest(files);expect(verifyManifest(manifest,files).status).toBe("valid");const altered=[{...files[0],bytes:Buffer.from("x")}];expect(verifyManifest(manifest,altered).errors.join(" ")).toContain(files[0].path);expect(verifyManifest(manifest,[]).status).toBe("invalid");expect(verifyManifest(manifest,[...files,{...files[0],path:"extra.json"}]).status).toBe("invalid");expect(verifyManifest(manifest,files,testKeys().publicKey).status).toBe("invalid");manifest.createdAt="2026-01-01T00:00:00Z";expect(verifyManifest(manifest,files).status).toBe("invalid");});
 const previous=process.env.AEGIS_MANIFEST_SIGNING_KEY;delete process.env.AEGIS_MANIFEST_SIGNING_KEY;try{const m=createManifest(files);expect(m.signing.status).toBe("unsigned");expect(verifyManifest(m,files).exitCode).toBe(2);expect(verifyManifest(m,files,testKeys().publicKey).exitCode).toBe(2);}finally{if(previous!==undefined)process.env.AEGIS_MANIFEST_SIGNING_KEY=previous;}
});
it("invalid OSCAL refuses export before directory writes and unsafe archive members are rejected",()=>{
 const folder=mkdtempSync(path.join(os.tmpdir(),"moat-export-"));try{
  expect(()=>writeBundleDirectory(path.join(folder,"out"),[{path:"ssp.json",mediaType:"application/oscal+json",bytes:Buffer.from('{"system-security-plan":{}}')}])).toThrow();expect(readdirSync(folder)).toEqual([]);
  expect(()=>readBundleZip(zipSync({"../escape":strToU8("x"),"manifest.json":strToU8("{}")}))).toThrow();
  signing(()=>{writeBundleDirectory(path.join(folder,"signed"),files);expect(verifyBundlePath(path.join(folder,"signed")).exitCode).toBe(0);writeFileSync(path.join(folder,"signed",files[0].path),"tampered");expect(verifyBundlePath(path.join(folder,"signed")).errors[0]).toContain(files[0].path);});
 }finally{rmSync(folder,{recursive:true,force:true});}
});
it("recorded Boutique export includes all retained bytes and API verifies signatures and tampering",async()=>{
 const old=process.env.AEGIS_DATA_DIR,folder=mkdtempSync(path.join(os.tmpdir(),"moat-bundle-")),oldKeys=[process.env.AEGIS_MANIFEST_SIGNING_KEY,process.env.AEGIS_MANIFEST_PUBLIC_KEY],keys=testKeys();process.env.AEGIS_DATA_DIR=folder;process.env.AEGIS_MANIFEST_SIGNING_KEY=keys.privateKey;process.env.AEGIS_MANIFEST_PUBLIC_KEY=keys.publicKey;
 try{const c=await createConnection("Recorded Boutique export test");await retainEvent(c.connection.id,JSON.stringify(original));await retainEvent(c.connection.id,JSON.stringify(retest));const bundle=await exportConnectionBundle(c.connection.id);expect(bundle.manifest.sourceRuns.map(r=>r.runId).sort()).toEqual(["40446239616","40446815397"]);const parsed=readBundleZip(bundle.bytes);expect(verifyManifest(parsed.manifest,parsed.files).exitCode).toBe(0);expect(parsed.files.filter(f=>f.path.startsWith("evidence/"))).toHaveLength(22);
  expect(parsed.files.some(f=>f.path==="plan-of-action-and-milestones.json")).toBe(false);expect(parsed.files.some(f=>f.path==="export-notes.json")).toBe(true);
  const sessionId="ed".repeat(16),issued=await createAgentToken(c.connection.id,c.owner,sessionId,["read"]),records=await connectionRecords(issued.record),source=records[0],issue=source.reviewItems![0];
  const draft=issueDraft(source,issue,{risk:"Recorded test finding requires review",action:"Proposed recorded fixture correction",verification:"Rerun the same scanner"}),key=`binder.plan-proposals.v1:${releaseProject(source.pipelineUrl)}`;
  await writeRemediationRecord(sessionId,{key,assessment:null,assessments:{},plans:[],issueDrafts:[draft],proposals:[decisionFromProposal(draft,{acceptance:"accepted"})]});
  const accepted=await exportConnectionBundle(c.connection.id,sessionId);expect(accepted.files.some(f=>f.path==="plan-of-action-and-milestones.json")).toBe(true);expect(verifyManifest(accepted.manifest,accepted.files).exitCode).toBe(0);
  const request=(bytes:Uint8Array)=>new Request("http://localhost/api/oscal/verify",{method:"POST",body:Uint8Array.from(bytes).buffer});
  expect((await verifyPost(request(bundle.bytes))).status).toBe(200);
  const altered={...bundle.files[0],bytes:Buffer.from("changed")},zip=zipSync(Object.fromEntries([...bundle.files.filter(f=>f.path!==altered.path),altered].map(f=>[f.path,f.bytes]).concat([["manifest.json",strToU8(JSON.stringify(bundle.manifest))]])));
  const failed=await verifyPost(request(zip));expect(failed.status).toBe(422);expect((await failed.json()).errors.join(" ")).toContain(altered.path);
 }finally{for(const [key,value]of Object.entries({AEGIS_DATA_DIR:old,AEGIS_MANIFEST_SIGNING_KEY:oldKeys[0],AEGIS_MANIFEST_PUBLIC_KEY:oldKeys[1]})){if(value===undefined)delete process.env[key];else process.env[key]=value;}rmSync(folder,{recursive:true,force:true});}
});

it("refuses private material in the public-key setting before it can reach an export",()=>{
 signing(()=>{process.env.AEGIS_MANIFEST_PUBLIC_KEY=process.env.AEGIS_MANIFEST_SIGNING_KEY;expect(()=>createManifest(files)).toThrow("Manifest signing configuration is invalid.");});
 signing(()=>{const pub=Buffer.from(process.env.AEGIS_MANIFEST_PUBLIC_KEY!,"base64").toString("utf8"),priv=Buffer.from(process.env.AEGIS_MANIFEST_SIGNING_KEY!,"base64").toString("utf8");process.env.AEGIS_MANIFEST_PUBLIC_KEY=Buffer.from(pub+priv).toString("base64");expect(()=>createManifest(files)).toThrow("Manifest signing configuration is invalid.");});
});
