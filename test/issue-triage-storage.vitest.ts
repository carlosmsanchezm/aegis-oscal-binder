import {afterEach,it,expect,vi} from "vitest";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {setBlobIoForTests} from "../lib/durable";
import {getStorage} from "../lib/storage";
import {readRemediation,writeRemediationRecord,remediationBlobPath} from "../lib/aegis/remediation-store";

let folder:string|undefined;
afterEach(()=>{setBlobIoForTests(null);vi.unstubAllEnvs();if(folder)rmSync(folder,{recursive:true,force:true});folder=undefined;});

it.each(["directory","blob"])("%s sessions ignore legacy triage without losing other saved data",async mode=>{
 const sid="ad".repeat(16),objects=new Map<string,string>();
 folder=mkdtempSync(path.join(tmpdir(),"triage-migration-"));
 vi.stubEnv("AEGIS_DATA_DIR",mode==="directory"?folder:"");
 vi.stubEnv("VERCEL_ENV","test");
 setBlobIoForTests({get:async key=>objects.get(key)??null,put:async(key,body)=>{objects.set(key,body);},list:async prefix=>[...objects.keys()].filter(key=>key.startsWith(prefix))});
 const supported={id:"triage:kept",issueId:"finding",receiptId:"receipt",outcome:"plan-it",reason:"Keep this decision",actor:"reviewer",at:"2026-10-28T12:00:00Z",source_label:{kind:"person"},acceptance:"accepted"};
 const record={key:"saved:record",assessment:{note:"Keep the assessment"},assessments:{},plans:[],proposals:[],issueTriage:[supported,{...supported,id:"triage:old",outcome:"accept-risk"},{...supported,id:"triage:old-space",outcome:"accept risk"},null,{outcome:"fix-now"}]};
 const other={key:"saved:other",assessment:null,assessments:{},plans:[],proposals:[]};
 const raw=JSON.stringify({savedAt:"2026-10-28T12:00:00Z",records:[record,other]}),file=path.join(folder,"sessions",sid,"remediation.json"),blob=remediationBlobPath(sid);
 if(mode==="directory")getStorage().write(file,raw);else objects.set(blob,raw);
 const restored=(await readRemediation(sid))!;
 expect(restored.records).toEqual([{...record,issueTriage:[supported]},other]);
 expect(mode==="directory"?getStorage().read(file).toString():objects.get(blob)).toBe(raw);
 const second={...supported,id:"triage:second",outcome:"fix-now"};
 await writeRemediationRecord(sid,{...record,issueTriage:[second,{...supported,outcome:"accept-risk"}]});
 const saved=(await readRemediation(sid))!;
 expect(saved.records.find(r=>r.key===record.key)).toMatchObject({assessment:record.assessment,issueTriage:[supported,second]});
 expect(saved.records.find(r=>r.key===other.key)).toEqual(other);
 const persisted=mode==="directory"?getStorage().read(file).toString():objects.get(blob)!;
 expect(persisted).not.toContain("accept-risk");expect(persisted).not.toContain("accept risk");
});
