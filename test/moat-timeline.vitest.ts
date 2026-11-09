import {it,expect,vi} from "vitest";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {appendTimeline,queryTimeline,verifyTimeline} from "../lib/timeline/store";
import {createConnection,retainEvent} from "../lib/server/builder-store";
import original from "../fixtures/boutique-live/40446239616/event.json";
import retest from "../fixtures/boutique-live/40446815397/event.json";
import {parseEvidenceEvent} from "../lib/builder/evidence";
import {digest} from "../lib/collector/collect";
it("recorded Boutique timeline indexes both runs, measured counts and removed frontend findings",async()=>{
 const old=process.env.AEGIS_DATA_DIR,folder=mkdtempSync(path.join(tmpdir(),"moat-timeline-"));process.env.AEGIS_DATA_DIR=folder;vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(new Date("2026-10-27T04:00:00Z"));
 try{const c=await createConnection("Recorded Boutique test");await retainEvent(c.connection.id,JSON.stringify(original));await retainEvent(c.connection.id,JSON.stringify(retest));await retainEvent(c.connection.id,JSON.stringify(original));const rows=await queryTimeline(c.connection.id,{control:"CM-6"});expect(rows).toHaveLength(2);expect(rows.map(r=>r.body.summary.configurationFindings)).toEqual([79,77]);expect(rows[1].body.summary.removedRules).toEqual(expect.arrayContaining([expect.stringContaining("KSV-0020"),expect.stringContaining("KSV-0021")]));expect(rows[0].body.collected).toBe(false);expect((await verifyTimeline(c.connection.id)).valid).toBe(true);const finding=rows[1].body.summary.removedFindings as string[];expect(await queryTimeline(c.connection.id,{finding:finding[0]})).toHaveLength(2);expect(await queryTimeline(c.connection.id,{control:"XX-999"})).toHaveLength(0);
 }finally{vi.useRealTimers();if(old===undefined)delete process.env.AEGIS_DATA_DIR;else process.env.AEGIS_DATA_DIR=old;rmSync(folder,{recursive:true,force:true});}
});
it("concurrent append slots form one chain and duplicate ids return the same entry",async()=>{
 const old=process.env.AEGIS_DATA_DIR,folder=mkdtempSync(path.join(tmpdir(),"moat-concurrency-"));process.env.AEGIS_DATA_DIR=folder;
 try{const c=await createConnection("Append test"),base={kind:"monitoring-capture" as const,source:{repo:"https://github.com/example/test"},commit:"a".repeat(40),observedAt:new Date().toISOString(),artifactSha256:["b".repeat(64)],controls:["CM-6"],findings:[],collected:true,summary:{}};
 const rows=await Promise.all(Array.from({length:8},(_,i)=>appendTimeline(c.connection.id,{...base,id:String(i)})));expect(new Set(rows.map(r=>r.hash)).size).toBe(8);expect((await verifyTimeline(c.connection.id)).valid).toBe(true);expect(await appendTimeline(c.connection.id,{...base,id:"0"})).toEqual(rows[0]);
 }finally{if(old===undefined)delete process.env.AEGIS_DATA_DIR;else process.env.AEGIS_DATA_DIR=old;rmSync(folder,{recursive:true,force:true});}
});
it("scheduled collector appends a monitoring capture at a fake clock time",async()=>{
 const old=process.env.AEGIS_DATA_DIR,folder=mkdtempSync(path.join(tmpdir(),"moat-cron-"));process.env.AEGIS_DATA_DIR=folder;vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(new Date("2026-10-27T04:00:00Z"));
 const {registerCollector,unregisterCollector}=await import("../lib/monitoring/registry");
 try{const c=await createConnection("Cron test"),capture=JSON.parse((await import("node:fs")).readFileSync("test/fixtures/monitoring/baseline-pass.json","utf8"));
  registerCollector({id:"moat-test-scheduled",triggers:["schedule"],async collect(){return null;},async scheduledScans(now){return [{connectionId:c.connection.id,capture,trigger:{kind:"schedule",repo:capture.captures[0].source.repo,revision:capture.captures[0].source.commit,at:now}}];}});
  const {runScheduledScans}=await import("../lib/monitoring/schedule");await runScheduledScans();await runScheduledScans();
  const rows=(await queryTimeline(c.connection.id)).filter(r=>r.body.kind==="monitoring-capture");expect(rows).toHaveLength(1);expect(rows[0].body.recordedAt).toBe("2026-10-27T04:00:00.000Z");
 }finally{unregisterCollector("moat-test-scheduled");vi.useRealTimers();if(old===undefined)delete process.env.AEGIS_DATA_DIR;else process.env.AEGIS_DATA_DIR=old;rmSync(folder,{recursive:true,force:true});}
});
it("existing GovCloud ingestion output is indexed without making an AWS call",async()=>{
 const old=process.env.AEGIS_DATA_DIR,folder=mkdtempSync(path.join(tmpdir(),"moat-reader-"));process.env.AEGIS_DATA_DIR=folder;
 try{const {scanFixture}=await import("../lib/collector/aws/run");const scan=scanFixture("fixtures/aws/empty-account","a".repeat(40),"2026-10-27T04:00:00Z");const c=await createConnection("Recorded reader test");for(const event of scan.events)await retainEvent(c.connection.id,event.rawEvent);const rows=await queryTimeline(c.connection.id);expect(rows.length).toBeGreaterThan(0);expect(rows.every(r=>r.body.kind==="govcloud-reader"&&r.body.source.accountId==="111122223333")).toBe(true);expect((await verifyTimeline(c.connection.id)).valid).toBe(true);
 }finally{if(old===undefined)delete process.env.AEGIS_DATA_DIR;else process.env.AEGIS_DATA_DIR=old;rmSync(folder,{recursive:true,force:true});}
});
it("complete AWS inventory attachments do not acquire a fake git source in the timeline",async()=>{
 const old=process.env.AEGIS_DATA_DIR,folder=mkdtempSync(path.join(tmpdir(),"moat-aws-inventory-"));process.env.AEGIS_DATA_DIR=folder;
 try{
  const {scanFixture}=await import("../lib/collector/aws/run"),scan=scanFixture("fixtures/aws/empty-account","a".repeat(40),"2026-10-27T04:00:00Z");
  const original=JSON.parse(scan.events[0].rawEvent),bytes=scan.events[0].rawEvent,name="event.json";
  const event=parseEvidenceEvent({...original,run:{...original.run,id:original.run.id+"-inventory"},checks:original.checks.map((c:{artifacts:string[]})=>({...c,artifacts:[name]})),
   artifacts:[{name,mediaType:"application/json",contentBase64:Buffer.from(bytes).toString("base64"),sha256:digest(bytes)}]});
  const c=await createConnection("AWS inventory unit test");await retainEvent(c.connection.id,JSON.stringify(event));
  const rows=await queryTimeline(c.connection.id);expect(rows).toHaveLength(1);expect(rows[0].body.source.repo).toBeUndefined();
  expect(rows[0].body.controls).toEqual([]);expect(rows[0].body.collected).toBe(false);expect((await verifyTimeline(c.connection.id)).valid).toBe(true);
 }finally{if(old===undefined)delete process.env.AEGIS_DATA_DIR;else process.env.AEGIS_DATA_DIR=old;rmSync(folder,{recursive:true,force:true});}
});
