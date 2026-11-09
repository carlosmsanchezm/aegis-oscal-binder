import baseline from "../../catalogs/fedramp-rev5-moderate.json" with { type: "json" };

/**
 * FedRAMP Rev 5 Moderate controls selected by the vendored profile.
 * Membership is the baseline list. It is not a satisfied, implemented, or authorized result.
 */
export type BaselineControl = {
  id: string;
  oscalId: string;
  title: string;
  enhancement: boolean;
  family: string;
};

export type BaselineFamily = {
  id: string;
  title: string;
  controls: BaselineControl[];
};

type BaselineFile = {
  sourceProfile: string;
  sourceCatalog: string;
  profileTitle: string;
  profileVersion: string;
  count: number;
  baseCount: number;
  enhancementCount: number;
  families: Array<{ id: string; title: string; controls: Array<Omit<BaselineControl, "family">> }>;
};

const file = baseline as BaselineFile;

export const MODERATE_BASELINE_COUNT = file.count;
export const MODERATE_BASELINE_BASE_COUNT = file.baseCount;
export const MODERATE_BASELINE_ENHANCEMENT_COUNT = file.enhancementCount;
export const MODERATE_BASELINE_PROFILE = file.profileTitle;
export const MODERATE_PROFILE_VERSION = file.profileVersion;
export const MODERATE_BASELINE_SOURCE = file.sourceProfile;
export const MODERATE_BASELINE_CATALOG = file.sourceCatalog;

export function moderateFamilies(): BaselineFamily[] {
  return file.families.map((family) => ({
    id: family.id,
    title: family.title,
    controls: family.controls.map((control) => ({ ...control, family: family.id })),
  }));
}

export function moderateControls(): BaselineControl[] {
  return moderateFamilies().flatMap((family) => family.controls);
}
