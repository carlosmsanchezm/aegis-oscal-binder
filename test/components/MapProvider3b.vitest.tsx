import React from 'react';
import {it,expect,vi} from 'vitest';
import {render,screen,fireEvent} from '@testing-library/react';
import {PipelineControlPanel} from '../../components/binder/RollupMap';
import {PackageMap} from '../../components/binder/PackageMap';
import {map} from '../pmap-r2-fixture';
vi.mock('../../components/binder/ControlFocus',async importOriginal=>({...await importOriginal<typeof import('../../components/binder/ControlFocus')>(),useStageSize:()=>({width:1280,height:500,gutter:0})}));
const provider={id:'EXAMPLE-provider',title:'EXAMPLE provider',short:'EXAMPLE provider',example:true};
it('renders supplied full/partial coverage, component labels and violet routes; never invents metadata',()=>{
 vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}});
 const first=map.controls[0],second=map.controls[1];
 const pkg={...map,controls:map.controls.map(c=>({...c,providerCoverage:c.id===first.id?[{provider,coverage:'all' as const}]:c.id===second.id?[{provider,coverage:'part' as const}]:undefined,implementedBy:c.id===first.id?[{id:'EXAMPLE-component',title:'EXAMPLE component',example:true}]:undefined}))};
 const {container}=render(<PackageMap pkg={pkg} snapshotSelector={<span>EXAMPLE fixture</span>} selectedId={first.id} level2={false} selectedItemId={null} onSelect={()=>{}} onEnterFocus={()=>{}} onLeaveFocus={()=>{}} onSelectItem={()=>{}}/>);
 expect(container.querySelector(`[data-control-id="${first.id}"]`)?.getAttribute('data-provider-coverage')).toBe('all');
 expect(container.querySelector(`[data-control-id="${second.id}"]`)?.getAttribute('data-provider-coverage')).toBe('part');
 expect(container.querySelector('[data-provider-id="EXAMPLE-provider"]')).not.toBeNull();
 expect(container.querySelector('[data-rel="provider"]')?.getAttribute('marker-end')).toBe('url(#pmap-provider-arrow)');
 expect(screen.getByText('Provider covers it')).toBeTruthy();
});
it('the provider panel uses supplied data and labels examples; ordinary controls keep the existing panel',()=>{
 const control={...map.controls[0],providerCoverage:[{provider,coverage:'all' as const}],implementedBy:[{id:'EXAMPLE-component',title:'EXAMPLE component',example:true}]};
 const {rerender}=render(<PipelineControlPanel pkg={map} control={control} result={null} level2={false} onClose={()=>{}} onExpand={()=>{}}/>);
 expect(screen.getByText('◆ Covered by provider')).toBeTruthy();expect(screen.getByText('Not needed from you')).toBeTruthy();expect(screen.getByText('Implemented by')).toBeTruthy();expect(screen.getByRole('listitem').textContent).toBe('EXAMPLE component');expect(screen.getAllByText('EXAMPLE')).toHaveLength(2);
 rerender(<PipelineControlPanel pkg={map} control={map.controls[0]} result={null} level2={false} onClose={()=>{}} onExpand={()=>{}}/>);
 expect(screen.queryByText('◆ Covered by provider')).toBeNull();expect(screen.queryByText('EXAMPLE')).toBeNull();expect(screen.getByText('None linked')).toBeTruthy();
});
