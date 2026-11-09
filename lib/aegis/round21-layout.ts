import { buildLayout } from "./map-placement";
import { controlBlockHeight, placeOneRow } from "./map-layout";
import type { PackageState } from "./types";

/** Round 21a–c geometry: one family band, roles above the controls, SSP evidence below. */
export function round21Layout(
  pkg: PackageState,
  viewWidth: number,
  panelOpen: boolean,
  viewHeight: number,
) {
  const width = Math.max(650, viewWidth);
  const height = Math.max(440, viewHeight);
  const base = buildLayout(pkg, width, panelOpen);
  if (pkg.controls.length > 24 || pkg.map.families.length > 9) return base;
  const families = pkg.map.families.filter((f) =>
    pkg.controls.some((c) => c.family === f.id),
  );
  const gap = 36;
  const pad = panelOpen ? 54 : 30;
  const available = width - pad * 2 - gap * (families.length - 1);
  const total = pkg.controls.length;
  let x = pad;
  const lanes = families.map((family, index) => {
    const members = pkg.controls.filter((c) => c.family === family.id);
    const prior = base.lanes.find((l) => l.id === family.id)!;
    const w = (available * members.length) / total;
    const lane = {
      ...prior,
      x,
      // A real gutter above and below the locked columns lets related paths
      // pass around family tiles without crossing their interiors.
      y: 24,
      w,
      h: height - 48,
      band: 0,
      alt: index % 2 === 1,
      headerH: 52,
    };
    x += w + gap;
    return lane;
  });
  const controlY = Math.min(195, height * 0.35);
  const controls = lanes.flatMap((lane) => {
    const members = base.controls
      .filter((c) => c.family === lane.id)
      .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
    const w = (lane.w - 12 - 8 * (members.length - 1)) / members.length;
    return members.map((c, i) => ({
      ...c,
      x: lane.x + 6 + i * (w + 8),
      y: controlY,
      w,
      h: controlBlockHeight(pkg.map.statements[c.id]?.items.length ?? 0, w),
    }));
  });
  const center = (id: string) => {
    const c = controls.find((c) => c.id === id);
    return c ? c.x + c.w / 2 : width / 2;
  };
  const roleRoom =
    (width - 16 - 8 * (base.roles.length - 1)) / Math.max(1, base.roles.length);
  const placedRoles = placeOneRow(
    base.roles.map((r) => ({
      id: r.id,
      w: Math.min(r.w, roleRoom),
      ideal:
        r.controlIds.reduce((sum, id) => sum + center(id), 0) /
        r.controlIds.length,
    })),
    { left: 8, right: width - 8 },
    62,
    8,
  );
  const roles = placedRoles.map((r) => ({
    ...base.roles.find((role) => role.id === r.id)!,
    ...r,
  }));
  const evidenceY = height - 110;
  const evidence = base.evidence.map((e) => ({
    ...e,
    y: evidenceY + e.row * 56,
    h: 48,
  }));
  const belowSlots = new Map<string, number>();
  const pills = base.pills.map((p) => {
    const c = controls.find((c) => c.id === p.controlId)!;
    const slot = belowSlots.get(p.controlId) ?? 0;
    if (p.kind !== "role") belowSlots.set(p.controlId, slot + 1);
    return {
      ...p,
      x: c.x + c.w / 2 - p.w / 2,
      y: p.kind === "role" ? controlY - 54 : evidenceY - 30 - slot * 20,
    };
  });

  return {
    ...base,
    width,
    height,
    lanes,
    controls,
    roles,
    evidence,
    pills,
    bundles: base.bundles,
    controlY,
    evidenceY,
    boxTop: 0,
  };
}
