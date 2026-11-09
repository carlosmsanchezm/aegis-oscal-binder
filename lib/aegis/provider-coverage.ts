import type {ControlView,PackageState} from './types';
import type {ProviderBox} from './package-map-focus';
/** Optional supplied fields only. Never infer coverage from a control/family id. */
export function providerExtent(control:ControlView|undefined){return control?.providerCoverage?.some(c=>c.coverage==='all')?'all':control?.providerCoverage?.length?'part':null;}
export function providerBoxes(pkg:PackageState,statements?:PackageState|null):ProviderBox[]{
 const boxes=new Map<string,ProviderBox>();
 for(const control of pkg.controls){const authored=statements?.controls.find(c=>c.id===control.id);const source={...control,...authored,providerCoverage:authored?.providerCoverage??control.providerCoverage};
  for(const coverage of source.providerCoverage??[]){const provider=coverage.provider,box=boxes.get(provider.id)??{id:provider.id,title:provider.title,subtitle:'',controlIds:[],example:provider.example};box.controlIds.push(control.id);boxes.set(provider.id,box);}
 }
 return [...boxes.values()].map(box=>({...box,controlIds:[...new Set(box.controlIds)],subtitle:`${box.example?'EXAMPLE · ':''}covers ${new Set(box.controlIds).size} controls`}));
}
