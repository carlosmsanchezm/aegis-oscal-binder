import {test} from 'node:test';
import assert from 'node:assert/strict';
import {workspaceSystemLabel,pipelineSystemName,connectionSystemLabel} from '../lib/aegis/workspace-label';
import {CCM_EXAMPLE,parseCcmSummary,summaryForSession} from '../lib/aegis/pipeline-evidence';
import {parseStoredPipelineEvidence} from '../lib/aegis/pipeline-inbound';
test('one workspace label rule preserves identity and appends source provenance once',()=>{
 assert.equal(workspaceSystemLabel(pipelineSystemName(CCM_EXAMPLE),'recorded example'),'Podinfo · recorded example');
 assert.equal(pipelineSystemName(parseCcmSummary(summaryForSession(CCM_EXAMPLE))),'Podinfo');
 assert.equal(pipelineSystemName(parseStoredPipelineEvidence({...CCM_EXAMPLE,source:'Inbound pipeline event'})),'Podinfo');
 for(const source of ['recorded example','received pipeline','captured reference','uploaded package'] as const){
  for(const name of ['custom system','Custom system · recorded','Custom system · captured reference'])assert.equal(workspaceSystemLabel(name,source),`Custom system · ${source}`);
 }
 const connection={id:'custom',name:'Custom system',createdAt:'',revokedAt:null,history:[]};
 assert.equal(connectionSystemLabel(connection),'Custom system · uploaded package');
 assert.equal(connectionSystemLabel({...connection,name:'Custom system · captured reference'}),'Custom system · captured reference');
});
