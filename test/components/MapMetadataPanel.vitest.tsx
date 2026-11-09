import React from 'react';
import {it,expect,vi} from 'vitest';
import {render,screen,fireEvent} from '@testing-library/react';
import {MapFamilyPanel,PipelineControlPanel} from '../../components/binder/RollupMap';
import {mapMetadata} from '../../lib/aegis/map-metadata';
import {shell} from '../pmap-r2-fixture';
vi.mock('../../components/binder/ControlFocus',async importOriginal=>({...await importOriginal<typeof import('../../components/binder/ControlFocus')>(),useStageSize:()=>({width:1280,height:500,gutter:0})}));
it('exposes labelled example components and the same owner filter in control and family inspectors',()=>{
 const {pkg,sources}=mapMetadata(shell,null,true),onOwner=vi.fn(),noop=()=>{};
 const {rerender}=render(<MapFamilyPanel pkg={pkg} familyId="CM" results={new Map()} onClose={noop} onSelect={noop} metadataSources={sources} owner="" onOwnerChange={onOwner}/>);
 expect(screen.getByTestId('panel-components').textContent).toContain('EXAMPLEImplemented byKubernetes platform');
 fireEvent.change(screen.getByLabelText('Owner in side panel'),{target:{value:'system-admin'}});expect(onOwner).toHaveBeenCalledWith('system-admin');
 expect(screen.getByRole('option',{name:'EXAMPLE · System Admin'})).toBeTruthy();
 rerender(<PipelineControlPanel pkg={pkg} control={pkg.controls.find(c=>c.id==='CM-6')!} result={null} level2={false} onClose={noop} onExpand={noop} metadataSources={sources} owner="system-admin" onOwnerChange={onOwner}/>);
 expect(screen.getByLabelText('Owner in side panel').getAttribute('disabled')).toBeNull();expect((screen.getByLabelText('Owner in side panel') as HTMLSelectElement).value).toBe('system-admin');
 expect(screen.getByText(/Assigned: System Administrator/)).toBeTruthy();expect(screen.getByRole('listitem').textContent).toBe('Kubernetes platform');
});
it('shows honest empty provider, component and ownership states in both inspectors',()=>{
 const noop=()=>{},control=shell.controls.find(c=>c.id==='CM-6')!;
 const {rerender}=render(<PipelineControlPanel pkg={shell} control={control} result={null} level2={false} onClose={noop} onExpand={noop}/>);
 expect(screen.getByText('No components supplied')).toBeTruthy();expect(screen.getByText('No provider coverage supplied')).toBeTruthy();expect(screen.getByLabelText('Owner in side panel').hasAttribute('disabled')).toBe(true);expect(screen.queryByText('EXAMPLE')).toBeNull();
 rerender(<MapFamilyPanel pkg={shell} familyId="CM" results={new Map()} onClose={noop} onSelect={noop}/>);
 expect(screen.getByText('No components supplied')).toBeTruthy();expect(screen.getByText('No provider coverage supplied')).toBeTruthy();expect(screen.getByRole('option',{name:'No owners supplied'})).toBeTruthy();expect(screen.queryByText('EXAMPLE')).toBeNull();
});

it('keeps snapshot result provenance while overlaying display metadata from the selected workspace',async()=>{
 const {RollupMap}=await import('../../components/binder/RollupMap');
 const {pkg,records,proposalCounts}=await import('../pmap-r2-fixture');
 vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}});
 const snapshot={...pkg,controls:pkg.controls.map(c=>({...c,rollupState:'recorded' as const,rollupReleaseId:'older-snapshot'}))};
 const membership={...pkg,controls:pkg.controls.map(c=>({...c,rollupState:'recorded' as const,rollupReleaseId:'latest-history'}))};
 const {container}=render(<RollupMap pkg={snapshot} mapStructure={membership} history={records} record={records[0]} packageControlIds={[]} proposalCounts={proposalCounts} onRecordChange={()=>{}} exampleMetadata/>);
 expect(container.querySelector('[data-control-id="CM-6"]')?.getAttribute('title')).toContain('#older-snapshot');
 expect(container.querySelector('[data-control-id="CM-6"]')?.getAttribute('title')).not.toContain('latest-history');
});

it('keeps the example coverage legend when covered controls are outside the visible subset',async()=>{
 const {RollupMap}=await import('../../components/binder/RollupMap');
 const {records}=await import('../pmap-r2-fixture');
 const onlyOneLinked={...shell,loaded:true,controls:shell.controls.map(c=>({...c,rollupState:c.id==='AC-6'?'recorded' as const:'blank' as const}))};
 const {container}=render(<RollupMap pkg={onlyOneLinked} history={records} record={records[0]} packageControlIds={[]} onRecordChange={()=>{}} exampleMetadata/>);
 expect(container.querySelectorAll('.pmap-control')).toHaveLength(1);
 expect(container.querySelector('.pmap-legend-provider')?.textContent).toContain('EXAMPLE DATA');
 expect(container.querySelector('.pmap-legend-provider')?.textContent).toContain('Provider covers it');
 expect(container.querySelector('[data-provider-id]')).toBeNull();
});
