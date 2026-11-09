import {referenceProposals as proposePlans} from "./support/reference-history";
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {PlanProposalProvider,ProposedPlanSummary} from '../components/binder/PlanProposal';
import {CCM_EXAMPLE} from '../lib/aegis/pipeline-evidence';
for(const readyEvidence of [false,true])test(`unresolved plan decisions show neutral disabled entry with ${readyEvidence?'known':'still restoring'} evidence`,()=>{
 const proposal=proposePlans([CCM_EXAMPLE]).find(p=>p.controlId==='CM-6')!;
 const html=renderToStaticMarkup(createElement(PlanProposalProvider,{releases:readyEvidence?[CCM_EXAMPLE]:[],planning:true,children:createElement(ProposedPlanSummary,{controlId:proposal.controlId,finding:proposal.finding,history:[CCM_EXAMPLE]})}));
 assert.match(html,/Loading saved plan/);assert.match(html,/<button[^>]*disabled/);assert.doesNotMatch(html,/Edit and accept|Proposed · not accepted/);
});
