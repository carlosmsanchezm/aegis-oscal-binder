import {test} from 'node:test';
import assert from 'node:assert/strict';
import {CCM_EXAMPLE,gitlabArtifactUrl} from '../lib/aegis/pipeline-evidence';
import {recordedEvidenceHref} from '../lib/aegis/recorded-evidence';
test('recorded viewer binds the actual retained source, never a different commit or digest on the same URL',()=>{
 const href=gitlabArtifactUrl(CCM_EXAMPLE,'configuration.json')!;
 assert.equal(recordedEvidenceHref(href,CCM_EXAMPLE),'/evidence/recorded/2894050908?artifact=configuration.json');
 assert.equal(recordedEvidenceHref(href,{...CCM_EXAMPLE,releaseSha256:'a'.repeat(64)}),null);
 assert.equal(recordedEvidenceHref(href,{...CCM_EXAMPLE,commitSha:'b'.repeat(40)}),null);
 assert.equal(recordedEvidenceHref(href.replace('16815627409','999999999'),CCM_EXAMPLE),null);
});
