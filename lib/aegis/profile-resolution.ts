import { AegisError } from "./errors";
import { MODERATE_BASELINE_BASE_COUNT, MODERATE_BASELINE_COUNT, MODERATE_BASELINE_ENHANCEMENT_COUNT, MODERATE_PROFILE_VERSION, moderateControls } from "./moderate-baseline";
import type { ControlRecord, ControlView, PersistedState } from "./types";

const PROFILE_UUID = "2b52ae35-a912-4549-94db-5a43b6607f86";
const PROFILE_FILE_NAME = "fedramp-rev5-moderate-profile.json";

/**
 * True when an import profile reference names the vendored FedRAMP Rev 5 Moderate profile.
 * The 12-control subset pin and the generic FedRAMP moderate URL are not this profile.
 */
export function referencesModerateProfile(href: string): boolean {
  const value = href.trim().toLowerCase();
  if (!value) return false;
  if (value === MODERATE_PROFILE_VERSION) return true;
  if (value.includes(PROFILE_UUID)) return true;
  return value.endsWith(PROFILE_FILE_NAME);
}

export function isResolvedModerateProfile(state: Pick<PersistedState, "resolvedProfile">): boolean {
  return state.resolvedProfile === true;
}

/** Nothing recorded: no implementation text, no role, and no evidence item. */
export function isUncoveredControl(control: {
  implementation: string;
  responsibleRoleId?: string;
  responsibleRoleIds?: string[];
  evidence: readonly unknown[];
}): boolean {
  const listed = (control.responsibleRoleIds ?? []).map((id) => id.trim()).filter(Boolean);
  const hasRole = listed.length > 0 || Boolean(control.responsibleRoleId?.trim());
  return !control.implementation.trim() && !hasRole && control.evidence.length === 0;
}

export function markResolvedBlanks<T extends ControlView>(controls: T[]): T[] {
  return controls.map((control) => (isUncoveredControl(control) ? { ...control, blank: true } : control));
}

function blankControl(control: { id: string; title: string; family: string }): ControlRecord {
  return {
    id: control.id,
    title: control.title,
    family: control.family,
    implementation: "",
    responsibleRoleId: "",
    responsibleRoleIds: [],
    evidence: [],
  };
}

/**
 * Replace the package control list with every control selected by the FedRAMP Rev 5 Moderate profile.
 * Controls already in the package keep their implementation, roles, evidence, and statement parts.
 * Profile controls with nothing recorded are added as blank.
 * An uploaded control the profile does not select is rejected with PROFILE_CONTROLS and the control ids.
 */
export function resolveModerateProfile(state: PersistedState): PersistedState {
  if (state.catalogId !== "fedramp-rev5") {
    throw new Error("The FedRAMP Rev 5 Moderate profile resolves only on the FedRAMP Rev5 catalog.");
  }
  const baseline = moderateControls();
  const base = baseline.filter((control) => !control.enhancement).length;
  const enhancements = baseline.filter((control) => control.enhancement).length;
  if (baseline.length !== MODERATE_BASELINE_COUNT || base !== MODERATE_BASELINE_BASE_COUNT || enhancements !== MODERATE_BASELINE_ENHANCEMENT_COUNT) {
    throw new Error("FedRAMP Rev 5 Moderate profile did not resolve to 323 controls (181 base and 142 enhancements).");
  }
  const selected = new Set(baseline.map((control) => control.id.toUpperCase()));
  const outside = [...new Set(state.controls.filter((control) => !selected.has(control.id.toUpperCase())).map((control) => control.id))].sort((a, b) => a.localeCompare(b));
  if (outside.length > 0) {
    throw new AegisError(
      "PROFILE_CONTROLS",
      `This package names the FedRAMP Rev 5 Moderate profile and includes controls that profile does not select: ${outside.join(", ")}.`,
      400,
    );
  }
  const byId = new Map(state.controls.map((control) => [control.id.toUpperCase(), control]));
  const controls = baseline.map((entry) => {
    const existing = byId.get(entry.id.toUpperCase());
    if (!existing) return blankControl(entry);
    return {
      ...existing,
      id: entry.id,
      title: entry.title,
      family: entry.family,
    };
  });
  return {
    ...state,
    loaded: true,
    catalogId: "fedramp-rev5",
    catalogPin: MODERATE_PROFILE_VERSION,
    resolvedProfile: true,
    controls,
  };
}
