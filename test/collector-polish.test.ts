import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {factCandidates} from '../lib/collector/mappings';
import {collectSource} from '../lib/collector/collect';
import {moderateControls} from '../lib/aegis/moderate-baseline';
import {GET} from '../app/api/builder/reference/route';
import {verifyBundle} from '../lib/server/builder-store';
import {summarizeBuilderBundle} from '../lib/server/builder-observation';
import {parseEvidenceEvent} from '../lib/builder/evidence';
import {connectedReleases} from '../lib/aegis/connected-evidence';
import {ArtifactMappingProposals} from '../components/binder/ArtifactMappingProposals';
import {BinderSummary} from '../components/binder/BinderSummary';
const ids=moderateControls().map(c=>c.id),allowed=new Set(ids);
const input={repo:'https://github.com/independent/service',commit:'a'.repeat(40),capturedAt:'2026-10-08T00:00:00.000Z'};
const candidates=(path:string,content:string)=>factCandidates(collectSource({...input,path,content})!,allowed,'fedramp-rev5').map(c=>c.controlId);
test('workflow permissions support least privilege, not account lifecycle or access enforcement',()=>{
 assert.deepEqual(candidates('.github/workflows/cve-scan.yml','permissions:\n  contents: read\n'),['AC-6']);
});
test('RBAC kinds and metrics do not propose account lifecycle or security audit record generation',()=>{
 assert.deepEqual(candidates('rbac.yaml','kind: Role\n'),['AC-3','AC-6']);
 assert.deepEqual(candidates('monitor.yaml','kind: ServiceMonitor\n'),['SI-4']);
});
test('dependency inventory and declared scans do not infer licensing restrictions or completed flaw remediation',()=>{
 assert.deepEqual(candidates('package.json','{"dependencies":{"example":"1.0.0"}}'),['CM-8']);
 assert.deepEqual(candidates('.github/workflows/scan.yml','jobs:\n  scan:\n    steps:\n      - run: trivy image app\n'),['CM-3','RA-5']);
});
async function records(){
 const c=await(await GET(new Request('http://localhost/api/builder/reference'))).json();
 const history=c.events.map((e:any)=>summarizeBuilderBundle(verifyBundle({schema:'aegis.evidence-bundle.v1',...e,connectionId:'11111111-1111-4111-8111-111111111111',receivedAt:JSON.parse(e.rawEvent).run.observedAt,event:parseEvidenceEvent(JSON.parse(e.rawEvent)),integrity:'verified',authentication:'browser-owner'})));
 return connectedReleases({id:'11111111-1111-4111-8111-111111111111',name:'A different display name',createdAt:input.capturedAt,revokedAt:null,history},'http://localhost');
}
test('current proposal rows select one stable file identity without deleting original and corrected receipts',async()=>{
 const releases=await records();const record=releases.at(-1)!;
 const html=renderToStaticMarkup(React.createElement(ArtifactMappingProposals,{record,releases,controlIds:ids,controlTitles:{},decisions:[],onDecision:async()=>{}}));
 assert.match(html,/145 pending/);
 assert.equal((html.match(/data-proposal-artifact="authorization-review.json"/g)??[]).length,1);
 assert.equal((html.match(/data-proposal-artifact="namespace-rbac.json"/g)??[]).length,1);
 assert.equal(releases.length,13);assert.equal(releases.flatMap(r=>r.artifacts??[]).length,200);
 assert.equal(releases.filter(r=>r.observation.reportedOutcome==='fail').length,1);
});
test('summary shows the manifest repo with the exact commit link and only 197 current files',async()=>{
 const releases=await records();
 const html=renderToStaticMarkup(React.createElement(BinderSummary,{record:releases.at(-1)!,records:releases,controlIds:ids}));
 assert.match(html,/https:\/\/github.com\/GoogleCloudPlatform\/microservices-demo\/tree\/38e7348eb289eb5b87c0c6e8cb19ced0449dc389/);
 assert.match(html,/200 artifact versions retained in receipt history/);
 assert.match(html,/197 files collected/);assert.match(html,/controls have suggested evidence/);assert.doesNotMatch(html,/data-touched-families/);
 assert.match(html,/GoogleCloudPlatform\/microservices-demo at 38e7348/);
});

test('bounded import workers overlap receipts and settle in-flight writes before failure',async()=>{
 const {importEvidenceEvents}=await import('../lib/client/import-evidence-events');
 const events=Array.from({length:7},(_,i)=>({id:String(i),rawEvent:String(i)}));
 let active=0,peak=0;const completed:string[]=[];
 await importEvidenceEvents(events,async()=>{peak=Math.max(peak,++active);await new Promise(resolve=>setTimeout(resolve,10));active--;},event=>completed.push(event.id));
 assert.equal(peak,4);assert.equal(active,0);assert.equal(completed.length,7);
 let outstanding=0;
 await assert.rejects(importEvidenceEvents(events,async event=>{outstanding++;await new Promise(resolve=>setTimeout(resolve,event.id==='0'?1:10));outstanding--;if(event.id==='0')throw new Error('Recorded rejection');},()=>{}),/Recorded rejection/);
 assert.equal(outstanding,0);
});

test('source commit links are provider-aware and reject credentials and unsafe protocols',async()=>{
 const {sourceCommitLink}=await import('../lib/collector/source-link');
 assert.deepEqual(sourceCommitLink(input),{name:'independent/service',href:`${input.repo}/tree/${input.commit}`,commit:input.commit});
 assert.equal(sourceCommitLink({...input,repo:'https://gitlab.com/team/project.git'})?.href,`https://gitlab.com/team/project/-/tree/${input.commit}`);
 assert.equal(sourceCommitLink({...input,repo:'javascript:alert(1)'}),null);
 assert.equal(sourceCommitLink({...input,repo:'https://user:secret@example.invalid/repo'}),null);
 assert.equal(sourceCommitLink({...input,commit:'main'}),null);
});

test('a person-approved collected artifact retains its upstream metadata in control and artifact views',async()=>{
 const {applyReleaseRollup}=await import('../lib/aegis/rollup-package');
 const {moderateRollupShell}=await import('../lib/aegis/rollup-shell');
 const {proposeArtifactMappings,mappingDecision,applyAcceptedArtifactMappings}=await import('../lib/aegis/artifact-mapping');
 const releases=await records(),record=releases.find(r=>r.collectedArtifacts?.some(a=>a.source.path==='kustomize/components/network-policies/network-policy-frontend.yaml'));
 // Fixture selection is by the exact original file, independently of candidate generation.
 assert.ok(record);const artifact=record.collectedArtifacts!.find(a=>a.source.path==='kustomize/components/network-policies/network-policy-frontend.yaml')!;
 const proposal=proposeArtifactMappings(record,ids).find(p=>p.artifact===artifact.name)!;
 const mapped=applyAcceptedArtifactMappings(record,[mappingDecision(record,proposal,'accepted',input.capturedAt,['SC-7'],'A person')]);
 const pkg=applyReleaseRollup(moderateRollupShell(process.cwd()),[mapped]);
 assert.deepEqual(pkg.controls.find(c=>c.id==='SC-7')!.evidence.find(e=>e.title===artifact.name)!.source,artifact.source);
});

test('current file keys distinguish different subjects, repos and source hashes',async()=>{
 const {currentArtifactSources,artifactSourceKey}=await import('../lib/aegis/artifact-sources');
 const releases=await records(),original=releases.find(r=>r.artifacts?.includes('authorization-review.json'))!;
 const different={...original,observation:{...original.observation,subject:{...original.observation.subject,id:'system:serviceaccount:other:reader'}}};
 assert.equal(currentArtifactSources([original,different]).size,6);
 const record=releases.find(r=>r.collectedArtifacts?.length)!;
 const artifact=record.collectedArtifacts![0];
 const altered={...record,collectedArtifacts:[{...artifact,source:{...artifact.source,sha256:'f'.repeat(64)}}]};
 assert.notEqual(artifactSourceKey(record,artifact.name),artifactSourceKey(altered,artifact.name));
});

test('duplicate receipt inputs do not inflate current inventory or control proposal counts',async()=>{
 const {currentBinderSummary,proposedControlCounts}=await import('../lib/aegis/binder-summary');
 const releases=await records(),duplicated=[...releases,...releases];
 const rows=currentBinderSummary(duplicated,ids);
 assert.equal(rows.length,197);assert.equal(new Set(rows.map(row=>row.key)).size,197);
 assert.deepEqual(proposedControlCounts(duplicated,ids),proposedControlCounts(releases,ids));
 const {applyReleaseRollup}=await import('../lib/aegis/rollup-package');
 const {moderateRollupShell}=await import('../lib/aegis/rollup-shell');
 const pkg=applyReleaseRollup(moderateRollupShell(process.cwd()),releases);
 const source=pkg.controls.find(c=>c.id==='AC-6')!.evidence[0].systemSources;
 assert.deepEqual(source,[{repo:'https://github.com/GoogleCloudPlatform/microservices-demo',commit:'38e7348eb289eb5b87c0c6e8cb19ced0449dc389'}]);
});
