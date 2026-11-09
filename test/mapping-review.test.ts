import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { emptyPersisted, getSession } from "../lib/aegis";
import { withSession } from "../lib/server/http";
import { sa1Request } from "../lib/server/sa1-router";
import { setBlobIoForTests } from "../lib/durable";
import { proposeArtifactMappings } from "../lib/aegis/artifact-mapping";
import { moderateControls } from "../lib/aegis/moderate-baseline";
import { CCM_EXAMPLE } from "../lib/aegis/pipeline-evidence";

const proposal = (ids: string[]) => proposeArtifactMappings(CCM_EXAMPLE,ids).find(p=>p.artifact==="configuration.raw.json")!;
const request = (cookie: string, body: unknown) => sa1Request(new Request("http://localhost/api/demo/sa1/pipeline/mappings",{method:"POST",headers:{cookie,"content-type":"application/json"},body:JSON.stringify(body)}),["pipeline","mappings"]);

test("server saves only the selected package candidates and rejects changed profiles",async()=>{
 const before=process.env.AEGIS_DATA_DIR;
 try {
  process.env.AEGIS_DATA_DIR=mkdtempSync(path.join(tmpdir(),"mapping-scope-"));
  const response=await withSession(new Request("http://localhost/api/package",{headers:{"x-aegis-workspace":"sa1-demo"}}),()=>{
   getSession().commit({...emptyPersisted(),catalogId:"fedramp-rev5",loaded:true,controls:[{id:"CM-6",title:"Configuration",family:"CM",implementation:"",responsibleRoleId:"",evidence:[]}]});
   return Response.json({ok:true});
  });
  const cookie=response.headers.getSetCookie().find(c=>c.startsWith("aegis_sa1_sid="))!.split(";")[0];
  const narrow=proposal(["CM-6"]);
  const accepted=await request(cookie,{proposalKey:narrow.key,profile:narrow.profile,status:"accepted"});
  assert.equal(accepted.status,200,await accepted.clone().text());
  assert.deepEqual((await accepted.json()).decision.controls,["CM-6"]);
  const wide=proposal(moderateControls().map(c=>c.id));
  assert.equal((await request(cookie,{proposalKey:wide.key,profile:wide.profile,status:"accepted"})).status,409);
  await withSession(new Request("http://localhost/api/package",{headers:{cookie,"x-aegis-workspace":"sa1-demo"}}),()=>{
   getSession().commit({...getSession().state,catalogId:"fedramp-20x",loaded:false,controls:[]});
   return Response.json({ok:true});
  });
  assert.equal((await request(cookie,{proposalKey:narrow.key,profile:narrow.profile,status:"accepted"})).status,409);
 } finally { if(before==null) delete process.env.AEGIS_DATA_DIR;else process.env.AEGIS_DATA_DIR=before; }
});

test("configured read/write failure never accepts via cookies or resurrects failed writes from memory",async()=>{
 const before={data:process.env.AEGIS_DATA_DIR,vercel:process.env.VERCEL,key:process.env.AEGIS_DEMO_COOKIE_KEY};
 try {
  delete process.env.AEGIS_DATA_DIR;process.env.VERCEL="1";process.env.AEGIS_DEMO_COOKIE_KEY="01".repeat(32);
  let readFails=false,writeFails=false;
  const stored=new Map<string,string>();
  setBlobIoForTests({get:async key=>{if(readFails)throw new Error("Durable read failed.");return stored.get(key)??null;},list:async()=>[],put:async(key,value)=>{if(writeFails)throw new Error("Durable write failed.");stored.set(key,value);}});
  const bootstrap=await sa1Request(new Request("http://localhost/api/demo/sa1/package"),["package"]);
  const cookie=bootstrap.headers.getSetCookie().find(c=>c.startsWith("aegis_sa1_sid="))!.split(";")[0];
  const p=proposal(moderateControls().map(c=>c.id));
  readFails=true;
  const readFailure=await request(cookie,{proposalKey:p.key,profile:p.profile,status:"accepted"});
  assert.equal(readFailure.status,503);
  assert.equal((await readFailure.json()).error.code,"STORE_UNAVAILABLE");
  readFails=false;writeFails=true;
  const writeFailure=await request(cookie,{proposalKey:p.key,profile:p.profile,status:"accepted"});
  assert.equal(writeFailure.status,500);
  assert.equal((await writeFailure.json()).error.code,"STORE_FAILED");
  assert.equal(writeFailure.headers.getSetCookie().some(c=>c.startsWith("aegis_sa1_snapshot_")),false);
  writeFails=false;
  const restored=await sa1Request(new Request("http://localhost/api/demo/sa1/pipeline/mappings",{headers:{cookie}}),["pipeline","mappings"]);
  assert.equal(restored.status,200);
  assert.deepEqual((await restored.json()).decisions,[]);
 } finally {
  setBlobIoForTests(null);
  for(const [env,value] of [["AEGIS_DATA_DIR",before.data],["VERCEL",before.vercel],["AEGIS_DEMO_COOKIE_KEY",before.key]]) {if(value==null)delete process.env[env!];else process.env[env!]=value;}
 }
});
