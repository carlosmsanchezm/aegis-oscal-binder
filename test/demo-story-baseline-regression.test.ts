import {referenceProposals as proposePlans} from "./support/reference-history";
import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {CCM_EXAMPLE} from '../lib/aegis/pipeline-evidence';
import {proposeArtifactMappings,mappingDecision} from '../lib/aegis/artifact-mapping';
import {moderateControls} from '../lib/aegis/moderate-baseline';
import {decisionFromProposal,applyDecision} from '../lib/aegis/plan-proposal';
import {buildBinderDocuments} from '../lib/aegis/baseline-binder';
import {rollupControlResults} from '../lib/aegis/control-rollup';
import {rankEffortNext} from '../lib/aegis/effort-ranking';
import {RollupMap} from '../components/binder/RollupMap';
import {moderateRollupShell} from '../lib/aegis/rollup-shell';
import {applyReleaseRollup} from '../lib/aegis/rollup-package';
// The base checkout's TSX server-render test path uses the classic JSX runtime.
(globalThis as typeof globalThis & {React: typeof React}).React=React;

test('baseline regression: unmapped inventory reaches another relevant catalog family',()=>{
 const record={...CCM_EXAMPLE,families:CCM_EXAMPLE.families.filter(f=>f.family==='SI'),artifacts:['sbom.cdx.json'],checks:[]};
 const proposals=proposeArtifactMappings(record,moderateControls().map(c=>c.id));
 assert.ok(proposals.some(p=>p.artifact==='sbom.cdx.json'&&p.candidates.some(c=>c.family==='CM')));
});

test('baseline regression: no untouched family appears until the person enables the toggle',()=>{
 const pkg=applyReleaseRollup(moderateRollupShell(process.cwd()),[CCM_EXAMPLE]);
 const html=renderToStaticMarkup(React.createElement(RollupMap,{pkg,history:[CCM_EXAMPLE],record:CCM_EXAMPLE,onRecordChange:()=>{},packageControlIds:[]}));
 assert.ok(!html.includes('data-family-box="AT"'));
 assert.match(html,/Show untouched controls/);
});

test('baseline regression: qualified person closure exports closed with a completion date',()=>{
 const draft=proposePlans([CCM_EXAMPLE]).find(p=>p.readyToClose)!;
 const patch={acceptance:'accepted' as const,closureConfirmed:true,closure:{name:'Regression reviewer',reason:'Reviewed passing measurements',at:'2026-10-08T22:00:00.000Z'}};
 const closed=applyDecision(draft,decisionFromProposal(draft,patch));
 const body=buildBinderDocuments([CCM_EXAMPLE],null,new Date(patch.closure.at),[closed]).poam['plan-of-action-and-milestones'] as any;
 assert.equal(body.risks[0].status,'closed');
 assert.ok(body['poam-items'][0].props.some((p:any)=>p.name==='completion-date'&&p.value===patch.closure.at));
});

test('baseline regression: risk takes priority over existing evidence cost',()=>{
 const input={rows:rollupControlResults([CCM_EXAMPLE]),relationships:[],postureLabel:'Catalog',riskRatings:{'AC-1':4,'CM-6':2}};
 assert.equal(rankEffortNext(input)[0].controlId,'AC-1');
});


test('baseline regression: accepting one mapping stores only that link and its reviewer',()=>{
 const proposal=proposeArtifactMappings(CCM_EXAMPLE,moderateControls().map(c=>c.id)).find(p=>p.candidates.length>1)!;
 const control=proposal.candidates[0].controlId;
 const decision=mappingDecision(CCM_EXAMPLE,proposal,'accepted','2026-10-08T22:00:00.000Z',[control],'Regression reviewer');
 assert.deepEqual(decision.controls,[control]);
 assert.equal(decision.reviewer,'Regression reviewer');
});

test('baseline regression: a bare confirmation cannot close a plan without person attribution',()=>{
 const draft=proposePlans([CCM_EXAMPLE]).find(p=>p.readyToClose)!;
 const saved=decisionFromProposal(draft,{acceptance:'accepted',closureConfirmed:true});
 assert.equal(applyDecision(draft,saved).closureConfirmed,false);
});

test('baseline regression: drafts expose the plain JSON contract from finding data',()=>{
 const draft=proposePlans([CCM_EXAMPLE])[0];
 assert.equal(draft.plain?.whatIsWrong,draft.finding);
 assert.equal(draft.plain?.whatWeWillDo,draft.action);
 assert.ok(draft.plain?.status);
});
