import copy from "../../catalogs/monitoring-copy.json" with { type: "json" };

export const monitoringCopy = copy;

export function driftLabel(drift: keyof typeof copy.classes): string {
  return copy.classes[drift];
}
