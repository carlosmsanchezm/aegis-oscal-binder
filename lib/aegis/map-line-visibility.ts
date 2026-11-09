export type MapLineFocus={hoveredEvidence?:string|null;selectedEvidence?:string|null;hoveredControl?:string|null;selectedControl?:string|null;familyControls?:ReadonlySet<string>|null};
/** Evidence lines are disclosure on the map, never a new mapping or inferred relationship. */
export function evidenceLinesVisible(id:string,controls:readonly string[],focus:MapLineFocus){
 return focus.hoveredEvidence===id||focus.selectedEvidence===id||controls.some(control=>control===focus.hoveredControl||control===focus.selectedControl||focus.familyControls?.has(control));
}
