import type {ControlView,PackageState} from './types';
import type {EvidenceConnection} from './connected-evidence';
import {EXAMPLE_PROVIDER,EXAMPLE_PARTIAL,EXAMPLE_COMPONENTS,EXAMPLE_EXTRA,EXAMPLE_ROLES,EXAMPLE_OWNERS} from './examples/package-map-3b';
export type MetadataSource='real'|'example'|'empty';
export type MapMetadataSources={provider:MetadataSource;components:MetadataSource;owners:MetadataSource};
const PINNED_BOUTIQUE=new Set(['bf083e020e937ee482a3f70863bc6cc31a22f63de4ee9f42e9a40d290069af3a','7c78c4bb75b2749aecd63d09c90c886ea2cbaaca7a4c19c0a92154c38b97406a']);
/** The explicit recorded selection, or a pinned captured-reference receipt. A workspace name alone is insufficient. */
export function capturedMapExample(connection:EvidenceConnection|null|undefined){return Boolean(connection&&/·\s*captured reference$/i.test(connection.name)&&connection.history.some(h=>PINNED_BOUTIQUE.has(h.id)));}
/** Read-only presentation projection. Canonical package, gates, evidence and exports remain untouched.
 * Each category uses real workspace data if any exists; never mix invented fallback into a real category. */
export function mapMetadata(pkg:PackageState,authored:PackageState|null|undefined,allowExample=false){
 const byId=new Map(authored?.controls.map(c=>[c.id,c]));
 let controls=pkg.controls.map(c=>{const a=byId.get(c.id);return {...c,providerCoverage:a?.providerCoverage??c.providerCoverage,implementedBy:a?.implementedBy??c.implementedBy,
  responsibleRoleId:a?.responsibleRoleId||c.responsibleRoleId,responsibleRoleIds:a?.responsibleRoleIds.length?a.responsibleRoleIds:c.responsibleRoleIds,
  responsibleRole:a?.responsibleRole||c.responsibleRole,roleLabels:a?.roleLabels.length?a.roleLabels:c.roleLabels};});
 let roles=[...new Map([...pkg.roles,...authored?.roles??[]].map(r=>[r.id,r])).values()];
 const source=(has:boolean):MetadataSource=>has?'real':allowExample?'example':'empty';
 const sources:MapMetadataSources={provider:source(controls.some(c=>c.providerCoverage?.length)),components:source(controls.some(c=>c.implementedBy?.length)),owners:source(roles.length>0||controls.some(c=>c.responsibleRoleIds.length||c.responsibleRole))};
 // Make supplied role assignments usable even when the source omitted a separate role declaration.
 if(sources.owners==='real')for(const c of controls)for(const [index,id] of [...new Set([c.responsibleRoleId,...c.responsibleRoleIds].filter(Boolean))].entries())if(!roles.some(r=>r.id===id))roles.push({id,title:c.roleLabels[index]||c.responsibleRole||id});
 if(sources.owners==='example')roles=EXAMPLE_ROLES;
 controls=controls.map(c=>{
  const all=c.family==='PE'||c.id==='SC-13',part=EXAMPLE_PARTIAL.has(c.id),ownerIds=EXAMPLE_OWNERS[c.id]??[];
  return {...c,...sources.provider==='example'?{providerCoverage:all||part?[{provider:EXAMPLE_PROVIDER,coverage:all?'all' as const:'part' as const}]:[]}:{},
   ...sources.components==='example'?{implementedBy:all?[]:[...new Set([...(EXAMPLE_COMPONENTS[c.family]??[]),...(EXAMPLE_EXTRA[c.id]??[])])].map(title=>({id:`EXAMPLE-${title}`,title,example:true}))}:{},
   ...sources.owners==='example'?{responsibleRoleId:ownerIds[0]??'',responsibleRoleIds:ownerIds,responsibleRole:roles.find(r=>r.id===ownerIds[0])?.title??'',roleLabels:ownerIds.map(id=>roles.find(r=>r.id===id)?.title??id)}:{}};
 });
 return {pkg:{...pkg,controls,roles},sources};
}
