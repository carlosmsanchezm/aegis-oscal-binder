import { getPackageState } from "./derive";
import { moderateControls, MODERATE_PROFILE_VERSION } from "./moderate-baseline";
import { emptyPersisted } from "./operations";
import type { PackageState } from "./types";

let cache: { root: string; shell: PackageState } | null = null;

/**
 * Map geometry for every Moderate control. Results are applied later from stored releases,
 * so this shell does not encode one system's evidence.
 */
export function moderateRollupShell(root: string): PackageState {
  if (cache?.root === root) return cache.shell;
  const state = emptyPersisted();
  state.loaded = true;
  state.catalogId = "fedramp-rev5";
  state.catalogPin = MODERATE_PROFILE_VERSION;
  state.workspaceName = "Stored releases";
  state.ingestKind = "oscal";
  state.controls = moderateControls().map((control) => ({
    id: control.id,
    title: control.title,
    family: control.family,
    implementation: "",
    responsibleRoleId: "",
    evidence: [],
  }));
  const shell = getPackageState(state, { root });
  cache = { root, shell };
  return shell;
}
