import {it,expect,vi,afterEach} from "vitest";
const io=vi.hoisted(()=>({text:null as string|null,version:0,race:null as null|(()=>void),fail:false,writes:[] as any[]}));
vi.mock("@vercel/blob",async importOriginal=>{
 const actual=await importOriginal<typeof import("@vercel/blob")>();
 return {...actual,head:async()=>({etag:String(io.version)}),get:async(_key:string,options:any)=>{if(options.headers)expect(options.headers["Accept-Encoding"]).toBe("identity");return io.text===null?null:{statusCode:200,blob:{etag:'"'+io.version+'"'},stream:new Response(io.text).body};},put:async(_key:string,body:string,options:any)=>{
  io.writes.push(options);if(io.fail)throw new Error("backend unavailable");
  const race=io.race;io.race=null;race?.();
  if(options.ifMatch!==undefined&&options.ifMatch!==String(io.version)||!options.allowOverwrite&&io.text!==null)throw new actual.BlobPreconditionFailedError();
  io.text=body;io.version++;
 }};
});
import {updateRemediationRecord,readRemediation} from "../lib/aegis/remediation-store";
const original={dir:process.env.AEGIS_DATA_DIR,token:process.env.BLOB_READ_WRITE_TOKEN,vercel:process.env.VERCEL_ENV};
afterEach(()=>{for(const [key,value] of Object.entries({AEGIS_DATA_DIR:original.dir,BLOB_READ_WRITE_TOKEN:original.token,VERCEL_ENV:original.vercel})){if(value===undefined)delete process.env[key];else process.env[key]=value;}});
function setup(){delete process.env.AEGIS_DATA_DIR;delete process.env.VERCEL_ENV;process.env.BLOB_READ_WRITE_TOKEN="synthetic-test-adapter";io.text=null;io.version=0;io.race=null;io.fail=false;io.writes=[];}
const session="7".repeat(32),key="binder.plan-proposals.v1:binder-connection:test";
const empty=()=>({key,assessment:null,assessments:{},plans:[],pullRequests:[]});
it("rereads after another instance changes the same Blob, preserving both registered PR links",async()=>{
 setup();await updateRemediationRecord(session,key,async()=>empty(),undefined,true);
 let runs=0;
 io.race=()=>{const external=JSON.parse(io.text!);external.records[0].pullRequests.push({prNumber:2});io.text=JSON.stringify(external);io.version++;};
 await updateRemediationRecord(session,key,async current=>{runs++;return {...current!,pullRequests:[...(current!.pullRequests??[]),{prNumber:3} as any]};},undefined,true);
 expect(runs).toBe(2);expect((await readRemediation(session))!.records[0].pullRequests!.map(p=>p.prNumber)).toEqual([2,3]);
 expect(io.writes.slice(1).map(o=>o.ifMatch)).toEqual(["1","2"]);
});
it("handles competing first creation and refuses an unavailable backend without an unconditional replacement",async()=>{
 setup();io.race=()=>{io.text=JSON.stringify({savedAt:new Date().toISOString(),records:[{...empty(),key:"other"}]});io.version++;};
 await updateRemediationRecord(session,key,async()=>empty(),undefined,true);
 expect((await readRemediation(session))!.records.map(r=>r.key)).toEqual(["other",key]);
 const before=io.text;io.fail=true;
 await expect(updateRemediationRecord(session,key,async c=>({...c!,plans:["changed"]}),undefined,true)).rejects.toThrow("Durable write failed");expect(io.text).toBe(before);
 expect(io.writes.at(-1).ifMatch).toBe(String(io.version));
});
