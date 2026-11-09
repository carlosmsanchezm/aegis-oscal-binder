import {it,expect} from 'vitest';
import {mapMetadata,capturedMapExample} from '../lib/aegis/map-metadata';
import {oscalMapMetadata} from '../lib/aegis/oscal-map-metadata';
import {map,shell} from './pmap-r2-fixture';
import {getPackageState,ingestOscalPackage,findRepoRoot} from '../lib/aegis';
import {readFileSync} from 'node:fs';
it('renders empty live metadata and explicit EXAMPLE recorded metadata without mutating canonical state',()=>{
 const before=JSON.stringify(shell),live=mapMetadata(shell,null),example=mapMetadata(shell,null,true);
 expect(live.sources).toEqual({provider:'empty',components:'empty',owners:'empty'});
 expect(live.pkg.controls.some(c=>c.providerCoverage?.length||c.implementedBy?.length)).toBe(false);
 expect(example.sources).toEqual({provider:'example',components:'example',owners:'example'});
 expect(example.pkg.controls.find(c=>c.id==='SC-13')?.providerCoverage?.[0]).toMatchObject({coverage:'all',provider:{example:true}});
 expect(example.pkg.controls.find(c=>c.id==='SC-7')?.providerCoverage?.[0].coverage).toBe('part');
 expect(example.pkg.controls.find(c=>c.id==='CM-6')?.implementedBy?.[0].title).toBe('Kubernetes platform');
 expect(example.pkg.controls.find(c=>c.id==='CM-6')?.responsibleRoleIds).toEqual(['system-admin','isso']);
 expect(example.pkg.controls.find(c=>c.id==='CM-7')?.responsibleRoleIds).toEqual([]);
 expect(JSON.stringify(shell)).toBe(before);expect(example.pkg.gate).toBe(shell.gate);expect(example.pkg.map).toBe(shell.map);
});
it('prefers real metadata per workspace category and never invents coverage for other real controls',()=>{
 const authored={...map,roles:[{id:'actual-owner',title:'Actual owner'}],controls:map.controls.map((c,i)=>({...c,...i===0?{providerCoverage:[{provider:{id:'actual-provider',title:'Actual provider'},coverage:'part' as const}],implementedBy:[{id:'actual-component',title:'Actual component'}],responsibleRoleId:'actual-owner',responsibleRoleIds:['actual-owner'],roleLabels:['Actual owner']}:{} }))};
 const result=mapMetadata(shell,authored,true);expect(result.sources).toEqual({provider:'real',components:'real',owners:'real'});
 expect(result.pkg.controls.filter(c=>c.providerCoverage?.length)).toHaveLength(1);expect(result.pkg.controls.flatMap(c=>c.implementedBy??[]).some(c=>c.example)).toBe(false);
 expect(result.pkg.roles).toEqual(authored.roles);
});
it('requires pinned captured receipts as well as captured-reference selection',()=>{
 const connection={id:'fixture',name:'Online Boutique · captured reference',createdAt:'',revokedAt:null,history:[]};
 expect(capturedMapExample(connection)).toBe(false);
 expect(capturedMapExample({...connection,history:[{id:'bf083e020e937ee482a3f70863bc6cc31a22f63de4ee9f42e9a40d290069af3a'} as never]})).toBe(true);
 expect(capturedMapExample({...connection,name:'Live Boutique',history:[{id:'bf083e020e937ee482a3f70863bc6cc31a22f63de4ee9f42e9a40d290069af3a'} as never]})).toBe(false);
});
it('projects explicit OSCAL components and inherited/shared coverage through the real importer',()=>{
 const fixture=JSON.parse(readFileSync('public/samples/sample-oscal-ssp-rev5.json','utf8')),ssp=fixture['system-security-plan'];
 const providerId='11111111-1111-4111-8111-111111111111',componentId=ssp['system-implementation'].components[0].uuid;
 ssp['system-implementation']['leveraged-authorizations']=[{uuid:providerId,title:'Supplied provider'}];
 const controls=ssp['control-implementation']['implemented-requirements'];
 for(const [index,req] of controls.slice(0,2).entries()){
  req.props=[{name:'control-origination',value:index?'shared':'inherited'},{name:'leveraged-authorization-uuid',value:providerId}];
  req['by-components']=[{'component-uuid':componentId,uuid:`22222222-2222-4222-8222-22222222222${index}`,description:'Supplied implementation',inherited:[{uuid:'33333333-3333-4333-8333-333333333333','provided-uuid':'44444444-4444-4444-8444-444444444444',description:'Supplied inherited statement'}]}];
 }
 const ctx={root:findRepoRoot(),now:()=>new Date('2026-10-28T12:00:00Z')};
 const imported=getPackageState(ingestOscalPackage({text:JSON.stringify(fixture),filename:'real-metadata.json',catalogId:'fedramp-rev5'},ctx),ctx);
 expect(imported.controls.find(c=>c.id==='AC-2')?.providerCoverage?.[0]).toEqual({provider:{id:providerId,title:'Supplied provider'},coverage:'all'});
 expect(imported.controls.find(c=>c.id==='AC-3')?.providerCoverage?.[0].coverage).toBe('part');
 expect(imported.controls.find(c=>c.id==='AC-2')?.implementedBy?.[0].title).toBe(ssp['system-implementation'].components[0].title);
 const unknown=oscalMapMetadata(ssp,{'control-id':'ac-4','by-components':[{'component-uuid':componentId,inherited:[{'provided-uuid':'unresolved'}]}]});
 expect(unknown.providerCoverage?.[0]).toMatchObject({coverage:'part',provider:{title:'Provider name not supplied'}});
 expect(oscalMapMetadata(ssp,{'control-id':'ac-5','by-components':[{'component-uuid':componentId}]}).providerCoverage).toBeUndefined();
});
