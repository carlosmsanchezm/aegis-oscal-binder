import {referenceProposals as proposePlans} from "./support/reference-history";
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {countLabel,utcTime,requestMessage} from '../lib/builder/presentation';
import before from '../lib/reference/online-boutique-before.json';
import after from '../lib/reference/online-boutique-after.json';
import {proposalStatus} from '../lib/aegis/plan-proposal';
import {CCM_EXAMPLE} from '../lib/aegis/pipeline-evidence';
import {PODINFO_RETEST_RECEIPT} from '../lib/aegis/control-rollup';
test('count copy handles zero, one, many and an irregular plural through one helper',()=>{
 for(const noun of ['finding','check','incomplete control'])assert.deepEqual([0,1,2].map(n=>countLabel(n,noun)),[`0 ${noun}s`,`1 ${noun}`,`2 ${noun}s`]);
 assert.equal(countLabel(2,'family','families'),'2 families');
});
test('Boutique captures have distinct millisecond timestamps without changing recorded bytes',()=>{
 const fail=JSON.parse(before.rawEvent).run.observedAt,pass=JSON.parse(after.rawEvent).run.observedAt;
 assert.equal(Date.parse(pass)-Date.parse(fail),250);
 assert.match(utcTime(fail,true),/02:54:20\.612 UTC/);assert.match(utcTime(pass,true),/02:54:20\.862 UTC/);
});
test('a passing measured retest proposes closure while person acceptance remains separate',()=>{
 const p=proposePlans([CCM_EXAMPLE,PODINFO_RETEST_RECEIPT]).find(p=>p.controlId==='CM-6'&&p.readyToClose)!;
 assert.ok(p);assert.equal(proposalStatus(p),'Closure proposed · Drafted · needs a person');
 assert.equal(proposalStatus({...p,acceptance:'accepted'}),'Closure proposed · Accepted · ready to close · needs a person');
});
test('transport failures get a recoverable message while specific rejection detail remains',()=>{
 assert.doesNotMatch(requestMessage(new TypeError('Failed to fetch'),'retry'),/Failed to fetch/);
 assert.match(requestMessage(new TypeError('Failed to fetch'),'retry'),/Retry this action/);
 assert.equal(requestMessage(new Error('Invalid risk statement'),'retry'),'Invalid risk statement');
});
test('single-statement Level 2 exposes the real catalog objective without inventing statement coverage',async()=>{
 const {createElement}=await import('react'),{renderToStaticMarkup}=await import('react-dom/server');
 const {Round21Focus}=await import('../components/binder/Round21Focus');
 const {moderateRollupShell}=await import('../lib/aegis/rollup-shell'),{findRepoRoot}=await import('../lib/aegis/paths');
 const pkg=moderateRollupShell(findRepoRoot()),control=pkg.controls.find(c=>c.id==='AC-6')!;
 const html=renderToStaticMarkup(createElement(Round21Focus,{pkg,control,observed:true,selectedItemId:null,onSelectItem(){},onBack(){},onSelect(){},onEvidence(){},snapshotSelector:null}));
 assert.match(html,/level2-assessment-objectives/);assert.match(html,/the principle of least privilege is employed/);
 assert.match(html,/No item-level evidence linked/);assert.match(html,/statement evidence mapping needs review/);
});
