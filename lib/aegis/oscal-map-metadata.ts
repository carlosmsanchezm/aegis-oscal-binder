import type {ControlView} from './types';
type ObjectMap=Record<string,unknown>;
const record=(v:unknown):ObjectMap=>v&&typeof v==='object'&&!Array.isArray(v)?v as ObjectMap:{};
const list=(v:unknown):ObjectMap[]=>v===undefined?[]:(Array.isArray(v)?v:[v]).map(record);
const text=(v:unknown)=>typeof v==='string'?v:'';
/** Display metadata from explicit SSP declarations, not inferred evidence coverage.
 * Inherited statement entries alone mean partial coverage. Full hatching requires
 * an explicit whole-requirement control-origination=inherited declaration. */
export function oscalMapMetadata(ssp:ObjectMap,requirement:ObjectMap):Pick<ControlView,'providerCoverage'|'implementedBy'>{
 const implementation=record(ssp['system-implementation']);
 const components=new Map(list(implementation.components??implementation.component).map(c=>[text(c.uuid),c]));
 const authorizations=new Map(list(implementation['leveraged-authorizations']??implementation['leveraged-authorization']).map(a=>[text(a.uuid),a]));
 const prop=(r:ObjectMap,name:string)=>text(list(r.props??r.prop).find(p=>p.name===name)?.value);
 const blocks=[...list(requirement['by-components']??requirement['by-component']),...list(requirement.statements??requirement.statement).flatMap(s=>list(s['by-components']??s['by-component']))];
 const implementedBy=[...new Set(blocks.map(b=>text(b['component-uuid'])).filter(Boolean))].flatMap(id=>{const c=components.get(id);return c&&text(c.title)?[{id,title:text(c.title)}]:[];});
 const providers=new Map<string,NonNullable<ControlView['providerCoverage']>[number]>();
 for(const block of [requirement,...blocks]){
  const component=components.get(text(block['component-uuid']))??{},inherited=list(block.inherited),origin=prop(block,'control-origination')||prop(requirement,'control-origination');
  if(!inherited.length&&!['inherited','shared'].includes(origin))continue;
  const ref=prop(block,'leveraged-authorization-uuid')||prop(requirement,'leveraged-authorization-uuid')||prop(component,'leveraged-authorization-uuid')||text(list(block.links??block.link).find(l=>l.rel==='leveraged-authorization')?.href).replace(/^#/,'');
  const authorization=authorizations.get(ref),id=ref||text(inherited[0]?.['provided-uuid']);if(!id)continue;
  const coverage=prop(requirement,'control-origination')==='inherited'?'all':'part';
  providers.set(id,{provider:{id,title:authorization?text(authorization.title)||'Provider name not supplied':'Provider name not supplied'},coverage});
 }
 return {...implementedBy.length?{implementedBy}:{},...providers.size?{providerCoverage:[...providers.values()]}:{}};
}
