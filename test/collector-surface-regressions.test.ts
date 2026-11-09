import assert from "node:assert/strict";
import test from "node:test";
import {readFileSync,writeFileSync,mkdtempSync,mkdirSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {execFileSync} from "node:child_process";
import {binderSummary, proposedControlCounts} from "../lib/aegis/binder-summary";
import {CCM_EXAMPLE} from "./support/collected-example";
import {moderateControls} from "../lib/aegis/moderate-baseline";
import {applyReleaseRollup} from "../lib/aegis/rollup-package";
import {moderateRollupShell} from "../lib/aegis/rollup-shell";
import {resultsMapPackage} from "../lib/aegis/results-map";
import {GET as reference} from "../app/api/builder/reference/route";
import {verifyBundle} from "../lib/server/builder-store";
import {summarizeBuilderBundle} from "../lib/server/builder-observation";
import {parseEvidenceEvent} from "../lib/builder/evidence";
import {connectedReleases} from "../lib/aegis/connected-evidence";
const ids=moderateControls().map(c=>c.id),connectionId="11111111-1111-4111-8111-111111111111";
test("refreshed pipeline sample inventories exact source facts, not filename claims",()=>{
 const rows=binderSummary(CCM_EXAMPLE,ids);
 assert.ok(rows.length>60);
 const source=rows.find(row=>row.collected?.source.path==="Dockerfile");
 assert.ok(source?.collected); assert.ok(source.collected.facts.some(f=>f.key==="base-image"));
 assert.equal(source.linked.length,0);assert.ok(source.proposed.length);
 assert.equal(new Set(rows.flatMap(row=>row.families)).size,new Set(resultsMapPackage(applyReleaseRollup(moderateRollupShell(process.cwd()),[CCM_EXAMPLE]),null,true,false,proposedControlCounts([CCM_EXAMPLE],ids)).map.families.map(f=>f.id)).size);
});
test("public reference uses actual connection events for dozens of files and the same visible family set",async()=>{
 const capture=await (await reference(new Request("http://localhost/api/builder/reference"))).json();
 const history=capture.events.map((c:any)=>summarizeBuilderBundle(verifyBundle({schema:"aegis.evidence-bundle.v1",...c,connectionId,receivedAt:JSON.parse(c.rawEvent).run.observedAt,event:parseEvidenceEvent(JSON.parse(c.rawEvent)),integrity:"verified",authentication:"browser-owner"})));
 const records=connectedReleases({id:connectionId,name:"Renamed system",createdAt:"2026-10-09T00:00:00.000Z",revokedAt:null,history},"http://localhost");
 const rows=records.flatMap(r=>binderSummary(r,ids));assert.ok(rows.length>60);assert.ok(rows.some(row=>row.collected?.source.path.includes("network-policy")));
 const families=[...new Set(rows.flatMap(r=>r.families))].sort();assert.ok(families.length>=8);
 const projected=resultsMapPackage(applyReleaseRollup(moderateRollupShell(process.cwd()),records),null,true,false,proposedControlCounts(records,ids));
 assert.deepEqual(projected.map.families.map(f=>f.id).sort(),families);
 assert.ok(projected.controls.some(c=>c.proposedEvidence?.length && c.rollupState==="blank"));
 const linked=projected.controls.find(c=>c.rollupState==="recorded")!;
 const authored={...projected,loaded:true,controls:[{...linked,rollupState:undefined,evidence:[{...linked.evidence[0],title:"Authored SSP evidence"}]}]};
 const combined=resultsMapPackage(projected,authored,true,false).controls.find(c=>c.id===linked.id)!;
 assert.equal(combined.rollupState,"recorded");assert.equal(combined.evidence[0].title,"Authored SSP evidence");
 const prior=records.find(r=>r.families.length)!.families[0].controls[0];assert.equal(projected.controls.find(c=>c.id===prior)?.rollupState,"recorded","Unaccepted newer findings must not displace the original measured link");
});
test("source CLI emits importable facts from an arbitrary pinned clean checkout and rejects dirty source",()=>{
 let base=process.env.AEGIS_TEST_SHA ?? "archive";try {base=execFileSync("git",["rev-parse","--short","HEAD"],{encoding:"utf8",stdio:["ignore","pipe","ignore"]}).trim();} catch {}
 const root=mkdtempSync(path.join(tmpdir(),`collector-cli-${base}-`)),repo=path.join(root,"source"),out=path.join(root,"output"),config=path.join(root,"sources.json");mkdirSync(repo);
 try {
  const git=(args:string[])=>execFileSync("git",args,{cwd:repo,encoding:"utf8",stdio:["ignore","pipe","pipe"]});
  git(["init","-q"]);writeFileSync(path.join(repo,"Dockerfile"),"FROM alpine:3.21\nUSER app\n");writeFileSync(path.join(repo,"README.md"),Buffer.from([0xff,0xfe,0xfd]));git(["add","Dockerfile","README.md"]);git(["-c","user.name=Collector Test","-c","user.email=collector@example.invalid","commit","-qm","Pinned test source"]);
  const commit=git(["rev-parse","HEAD"]).trim();writeFileSync(config,JSON.stringify({sources:[{directory:repo,repo:"https://github.com/example/independent-service",commit,capturedAt:"2026-10-08T00:00:00.000Z"}]}));
  const run=()=>execFileSync(process.execPath,["--import","tsx","scripts/collect-evidence.ts",config,out],{cwd:process.cwd(),encoding:"utf8",stdio:["ignore","pipe","pipe"]});
  assert.doesNotThrow(run,"Collector CLI must execute for a pinned repository");const capture=JSON.parse(readFileSync(path.join(out,"capture.json"),"utf8")).captures[0];assert.equal(capture.artifacts.length,1);assert.ok(capture.excluded.some((file:any)=>file.path==="README.md"&&file.reason.includes("encoding")));assert.equal(capture.artifacts[0].source.commit,commit);assert.equal(capture.artifacts[0].facts[1].value,"app");
  const event=parseEvidenceEvent(JSON.parse(readFileSync(path.join(out,`event-${capture.events[0].id}.json`),"utf8")));assert.equal(event.subject.revision,commit);assert.equal(event.artifacts.length,1);
  writeFileSync(path.join(repo,"Dockerfile"),"FROM alpine:3.21\nUSER root\n");assert.throws(run,/clean source checkout/);
 } finally {rmSync(root,{recursive:true,force:true});}
});
