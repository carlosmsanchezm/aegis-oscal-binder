"use client";
import React from "react";
/** Bottom-right map tools. The dock moves left of an open side panel so it is never covered.
 * The Pan button carries its own explanation; the former hint text was removed. */
export function MapZoomControl({scale,onZoom,onReset,onFit,panMode=false,onPanMode,panelOpen=false}:{scale:number;onZoom:(factor:number)=>void;onReset:()=>void;onFit:()=>void;panMode?:boolean;onPanMode?:(on:boolean)=>void;panelOpen?:boolean}){
 return <div className="pmap-zoom-dock" data-panel-open={panelOpen?"true":undefined}>
  <div className="pmap-zoom" role="group" aria-label="Zoom">
   <button type="button" aria-label="Zoom out" onClick={()=>onZoom(1/1.2)}>−</button>
   <button type="button" className="pmap-zoom-pct" title="Back to 100%" onClick={onReset}>{Math.round(scale*100)}%</button>
   <button type="button" aria-label="Zoom in" onClick={()=>onZoom(1.2)}>+</button>
   <button type="button" title="Fit the whole map on screen" onClick={onFit}>Fit</button>
   {onPanMode&&<button type="button" className="pmap-pan-toggle" aria-pressed={panMode} title="Pan: drag anywhere on the map to move it" onClick={()=>onPanMode(!panMode)}><svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3V21M3 12H21M12 3L9 6M12 3L15 6M12 21L9 18M12 21L15 18M3 12L6 9M3 12L6 15M21 12L18 9M21 12L18 15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg>Pan</button>}
  </div>
 </div>;
}
