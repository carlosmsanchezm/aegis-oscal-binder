"use client";
import React from 'react';
import type {ControlView,PackageState} from '@/lib/aegis/types';
import type {MapMetadataSources} from '@/lib/aegis/map-metadata';
import {MapOwnerPicker} from './MapOwnerPicker';
export function MapMetadataPanel({pkg,controls,sources,owner,onOwnerChange}:{pkg:PackageState;controls:ControlView[];sources?:MapMetadataSources;owner:string;onOwnerChange:(value:string)=>void}){
 const components=[...new Map(controls.flatMap(c=>c.implementedBy??[]).map(c=>[c.id,c])).values()];
 const coverage=[...new Map(controls.flatMap(c=>c.providerCoverage??[]).map(c=>[c.provider.id,c])).values()];
 const owners=[...new Set(controls.flatMap(c=>c.roleLabels.length?c.roleLabels:c.responsibleRole?[c.responsibleRole]:[]))];
 return <div className="panel-map-metadata" data-testid="map-panel-metadata">
  <div className="panel-components" data-testid="panel-components">{components.some(c=>c.example)&&<b className="pm-example">EXAMPLE</b>}{components.length?<><span>Implemented by</span><ul className="panel-component-list">{components.map(c=><li key={c.id}>{c.title}</li>)}</ul></>:<span className="hint">No components supplied</span>}</div>
  <div className="panel-provider" data-testid="panel-provider">{coverage.some(c=>c.provider.example)&&<b className="pm-example">EXAMPLE</b>}{coverage.length?coverage.map(c=><span key={c.provider.id}>{c.provider.short??c.provider.title} covers {controls.every(control=>control.providerCoverage?.some(entry=>entry.provider.id===c.provider.id&&entry.coverage==='all'))?'all':'part'}</span>):<span className="hint">No provider coverage supplied</span>}</div>
  <MapOwnerPicker pkg={pkg} value={owner} onChange={onOwnerChange} panel example={sources?.owners==='example'}/>
  <small className="panel-assigned-owner">{sources?.owners==='example'&&<b className="pm-example">EXAMPLE</b>}{owners.length?`Assigned: ${owners.join(', ')}`:'No owner assigned'} · filters map</small>
 </div>;
}
