import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {Round21Focus} from '../components/binder/Round21Focus';
import {findRepoRoot,getPackageState,ingestOscalPackage} from '../lib/aegis';
import {sa1Document} from '../lib/aegis/sa1-demo';
import {CCM_EXAMPLE} from '../lib/aegis/pipeline-evidence';
import {applyReleaseRollup} from '../lib/aegis/rollup-package';
import {moderateRollupShell} from '../lib/aegis/rollup-shell';
for(const observations of [true,false])test(`CM-6 SSP statement evidence ${observations?'coexists with retained observations without changing package state':'does not invent retained observation artifacts or review actions'}`,()=>{
 const root=findRepoRoot(),outDir=mkdtempSync(path.join(tmpdir(),'binder-statement-display-')),ctx={root,outDir,now:()=>new Date('2026-10-08T18:00:00Z')};
 try{
  const pkg=getPackageState(ingestOscalPackage({text:sa1Document(),filename:'synthetic-ssp.json',catalogId:'fedramp-rev5'},ctx),ctx);
  const control=pkg.controls.find(c=>c.id==='CM-6')!,pipelineControl=observations?applyReleaseRollup(moderateRollupShell(root),[CCM_EXAMPLE]).controls.find(c=>c.id==='CM-6'):undefined;
  const before=JSON.stringify(pkg);const markup=renderToStaticMarkup(createElement(Round21Focus,{pkg,control,pipelineControl,observedRecord:observations?CCM_EXAMPLE:undefined,selectedItemId:'cm-6_smt.a',onSelectItem(){},onBack(){},onSelect(){},onEvidence(){},snapshotSelector:null}));
  const row=markup.split('data-statement-evidence="cm-6_smt.a"')[1].split('data-statement-evidence="cm-6_smt.b"')[0];
  assert.match(row,/SSP evidence · package-declared links/);assert.match(row,/Baseline manifest/);assert.match(row,/data-evidence-origin="ssp"/);
  if(observations){assert.match(row,/Retained observation · #2894050908/);assert.match(row,/configuration.json/);assert.equal((row.match(/data-evidence-origin="observation"/g)??[]).length,3);assert.match(row,/Review mapping from configuration.json to cm-6_smt.a/);}
  else{assert.doesNotMatch(row,/data-evidence-origin="observation"|Review mapping from|Retained observation/);}
  assert.equal(JSON.stringify(pkg),before);
 }finally{rmSync(outDir,{recursive:true,force:true});}
});
