import type {PackageState} from "./types";

/** Snapshot selection affects result fields only. History owns map membership. */
export function resultsMapPackage(pkg: PackageState, subset: PackageState | null, _highlighted: boolean, allFamilies: boolean, proposals?: ReadonlyMap<string, number>): PackageState {
  const supported = pkg.controls.filter(control => control.rollupState === "recorded" || (proposals?.get(control.id) ?? 0) > 0);
  const members = allFamilies ? pkg.controls : supported.length ? supported : subset?.controls ?? [];
  const controls = members.map(control => {
    const authored = subset?.controls.find(item => item.id === control.id);
    return authored ? {...authored, rollupState: control.rollupState, rollupReleaseId: control.rollupReleaseId, proposedEvidence: control.proposedEvidence} : {...control, implementation:"", evidence:[], validEvidenceCount:0, responsibleRoleId:"", responsibleRole:"", responsibleRoleIds:[], roleLabels:[]};
  });
  const familyIds = new Set(controls.map(control => control.family));
  const base = subset ?? pkg;
  return {...base, controls, map: {...base.map,
    families: pkg.map.families.filter(family => familyIds.has(family.id)),
    edges: pkg.map.edges,
    statements: {...pkg.map.statements, ...subset?.map.statements},
    byControl: {...pkg.map.byControl, ...subset?.map.byControl},
    bundles: pkg.map.bundles.filter(bundle => familyIds.has(bundle.left) && familyIds.has(bundle.right)),
  }};
}
