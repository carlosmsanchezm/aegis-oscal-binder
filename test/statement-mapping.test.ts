import {test} from 'node:test';
import assert from 'node:assert/strict';
import {GET as getPackage} from '../app/api/package/route';
import {GET,POST} from '../app/api/statement-mappings/route';
import {CCM_EXAMPLE} from '../lib/aegis/pipeline-evidence';
import {normalizeStatementMapping,STATEMENT_MAPPING_KEY} from '../lib/aegis/statement-mapping';
import {remediationSessionCookie,readRemediationCookie} from '../lib/server/remediation-session';
test('statement mapping reviews bind a real source and statement, persist in their own session, and reopen separately from package gates',async()=>{
 const bootstrap=await getPackage(new Request('http://127.0.0.1/api/package'));
 const sid=bootstrap.headers.getSetCookie().find(c=>c.startsWith('aegis_sid='))!.split(';')[0];
 const read=()=>GET(new Request('http://127.0.0.1/api/statement-mappings',{headers:{cookie:sid}}));
 const first=await read(),scope=(await first.json()).sessionScope;
 const value={controlId:'CM-6',statementId:'cm-6_smt.a',evidenceId:`${CCM_EXAMPLE.pipelineId}:${CCM_EXAMPLE.artifactJobId}:${CCM_EXAMPLE.releaseSha256}:configuration.json`,sourceReleaseId:CCM_EXAMPLE.pipelineId,sourceSha256:CCM_EXAMPLE.releaseSha256,reviewer:'Reviewer',basis:'Checked the captured configuration for this statement.',action:'review'};
 const write=(patch:Record<string,unknown>={},fingerprint=scope,cookie=sid)=>POST(new Request('http://127.0.0.1/api/statement-mappings',{method:'POST',headers:{cookie,'content-type':'application/json','x-aegis-expected-session':fingerprint},body:JSON.stringify({...value,...patch})}));
 const saved=await write();assert.equal(saved.status,200,JSON.stringify(await saved.clone().json()));const data=await saved.json();assert.equal(data.reviews.length,1);assert.ok(normalizeStatementMapping(data.reviews[0]));assert.equal((await (await read()).json()).reviews.length,1);
 assert.equal((await (await getPackage(new Request('http://127.0.0.1/api/package',{headers:{cookie:sid}}))).json()).packageState.loaded,false);
 assert.equal((await (await GET(new Request('http://127.0.0.1/api/statement-mappings'))).json()).reviews.length,0);
 for(const patch of [{statementId:'cm-6_smt.fake'},{sourceSha256:'a'.repeat(64)},{evidenceId:'fake'}])assert.equal((await write(patch)).status,409);
 assert.equal((await write({reviewer:''})).status,400);
 const delayed=await write({},scope,'');assert.equal(delayed.status,409);assert.deepEqual(delayed.headers.getSetCookie(),[]);
 assert.equal((await write({action:'reopen'})).status,200);assert.equal((await (await read()).json()).reviews.length,0);
});
test('encrypted session transport retains mapping reviews and rejects malformed or foreign-session decisions',()=>{
 const secret=Buffer.alloc(32,19),sid='ab'.repeat(16),req=new Request('http://127.0.0.1');
 const review={id:'a'.repeat(64),controlId:'AC-6',statementId:'ac-6_smt',evidenceId:'artifact',sourceReleaseId:'capture',sourceSha256:'b'.repeat(64),reviewer:'Reviewer',basis:'Scoped support',reviewedAt:'2026-10-08T00:00:00.000Z'};
 const record={key:STATEMENT_MAPPING_KEY,assessment:null,assessments:{},plans:[],proposals:[],statementMappings:[review]};
 const cookie=remediationSessionCookie(record,sid,req,secret).split(';')[0];assert.deepEqual(readRemediationCookie(cookie,sid,secret),[record]);assert.deepEqual(readRemediationCookie(cookie,'cd'.repeat(16),secret),[]);
 assert.equal(normalizeStatementMapping({...review,reviewer:''}),null);assert.equal(normalizeStatementMapping({...review,sourceSha256:'bad'}),null);
});
