import { compareControlId } from "./control-order";
import {
  CONTROL_H,
  controlBlockHeight,
  EVIDENCE_H,
  EVIDENCE_Y,
  FAMILY_GAP,
  FAMILY_HEADER_GAP,
  familyHeaderHeight,
  FAMILY_PAD,
  LAYOUT_HEIGHT,
  ROLE_H,
  ROLE_PILL_BAND,
  ROLE_TO_BOX,
  ROLE_Y,
  ROLE2_Y,
  bundleDepth,
  pointAlong,
  controlFaceWidth,
  controlFaceStatus,
  evidenceTextWidth,
  evidenceWidth,
  familyBaselineText,
  familyCountText,
  familyHeaderWidth,
  familyLines,
  splitBaseline,
  gapLabel,
  manropeWidth,
  monoWidth,
  mean,
  placeOneRow,
  roleWidth,
} from "./map-layout";
import { bundleCountBadge, evidenceCountLine } from "./map-view";
import { treePath } from "./selected-tree";
import type { PackageState } from "./types";

const COVERAGE_FAMILY_LINES: Record<string, [string, string]> = {
  AC: ["Access", "Control"], AT: ["Awareness", "& Training"], AU: ["Audit &", "Accountability"],
  CA: ["Assessment", "& Monitoring"], CM: ["Configuration", "Management"], CP: ["Contingency", "Planning"],
  IA: ["Identification", "& Auth."], IR: ["Incident", "Response"], MA: ["Maintenance", ""],
  MP: ["Media", "Protection"], PE: ["Physical &", "Environmental"], PL: ["Planning", ""],
  PS: ["Personnel", "Security"], RA: ["Risk", "Assessment"], SA: ["System &", "Services Acq."],
  SC: ["System &", "Comms Prot."], SI: ["System &", "Info Integrity"], SR: ["Supply Chain", "Risk Mgmt"],
};
const CONTROL_FLOOR = 60;
const CONTROL_MAX = 88;
const CONTROL_GAP = 6;
const ROW_GAP = 8;
const PILL_H = 16;
const PILL_GAP = 8;

export type LayoutControl = {
  id: string;
  title: string;
  family: string;
  complete: boolean;
  missing: string[];
  x: number;
  y: number;
  w: number;
  h: number;
};

export type LayoutPill = {
  controlId: string;
  kind: string;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
};

export type LayoutLane = {
  id: string;
  title: string;
  titleLines: [string, string];
  countText: string;
  baselineText: string;
  baselineLines: [string, string];
  headerH: number;
  moderate: number | null;
  within: number;
  open: number;
  total: number;
  memberIds: string[];
  x: number;
  y: number;
  w: number;
  h: number;
  band: number;
  alt: boolean;
};

function sortedControls(pkg: PackageState) {
  return [...pkg.controls].sort((a, b) => compareControlId(a.id, b.id));
}

function roleNodes(pkg: PackageState) {
  const grouped = new Map<string, { id: string; label: string; title: string; controlIds: string[] }>();
  for (const control of sortedControls(pkg)) {
    control.responsibleRoleIds.forEach((roleId, index) => {
      const role = pkg.roles.find((item) => item.id === roleId);
      const title = role?.title || control.roleLabels[index] || roleId;
      const label = role?.shortName || title;
      const node = grouped.get(roleId) ?? { id: roleId, label, title, controlIds: [] };
      if (!node.controlIds.includes(control.id)) node.controlIds.push(control.id);
      grouped.set(roleId, node);
    });
  }
  for (const node of grouped.values()) node.controlIds.sort(compareControlId);
  return [...grouped.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function evidenceNodes(pkg: PackageState) {
  const grouped = new Map<string, { id: string; displayId?: string; title: string; uuid: string; controlIds: string[]; families: Set<string> }>();
  for (const control of sortedControls(pkg)) {
    for (const item of control.evidence) {
      const key = item.uuid || item.id;
      const node = grouped.get(key);
      if (!node) {
        grouped.set(key, {
          id: item.id,
          displayId: item.displayId,
          title: item.title,
          uuid: item.uuid,
          controlIds: [control.id],
          families: new Set([control.family]),
        });
        continue;
      }
      if (!node.controlIds.includes(control.id)) node.controlIds.push(control.id);
      node.families.add(control.family);
    }
  }
  return [...grouped.values()].map((node) => {
    node.controlIds.sort(compareControlId);
    const line = evidenceCountLine(node.controlIds.length, node.families.size);
    return { ...node, subtitle: line, detail: line };
  });
}

type FamilyInput = { id: string; members: number; header: number; narrow: number };
type BandPlan = { bands: number[][]; cw: number; narrow: boolean; totals: number[] };

function boxWidth(header: number, members: number, cw: number, compact = false): number {
  const controls = members > 0 ? members * cw + (members - 1) * CONTROL_GAP : 0;
  return Math.max(controls, header) + 2 * (compact ? 8 : FAMILY_PAD);
}

function bandTotal(families: FamilyInput[], band: number[], cw: number, narrow: boolean, compact = false): number {
  return band.reduce((sum, index) => sum + boxWidth(narrow ? families[index].narrow : families[index].header, families[index].members, cw, compact), 0)
    + (compact ? 36 : FAMILY_GAP) * Math.max(0, band.length - 1);
}

function widestFit(families: FamilyInput[], band: number[], low: number, high: number, room: number, narrow: boolean): number {
  if (bandTotal(families, band, high, narrow) <= room) return high;
  let lo = low;
  let hi = high;
  for (let step = 0; step < 32; step += 1) {
    const mid = (lo + hi) / 2;
    if (bandTotal(families, band, mid, narrow) <= room) lo = mid;
    else hi = mid;
  }
  return Math.floor(lo * 100) / 100;
}

/**
 * Family boxes, each one row of controls. All families share one band when they fit the
 * view, first with whole baseline lines, then with baselines broken at the middle dot.
 * Otherwise families wrap, in family order, into as many bands as the view needs. One
 * control width holds across every band: the widest that fits the fullest band.
 */
function planBands(families: FamilyInput[], room: number, cwMin: number, cwMax: number): BandPlan {
  const all = families.map((_, index) => index);
  const finish = (bands: number[][], narrow: boolean): BandPlan => {
    const cw = Math.min(...bands.map((band) => widestFit(families, band, cwMin, cwMax, room, narrow)));
    return { bands, cw, narrow, totals: bands.map((band) => bandTotal(families, band, cw, narrow)) };
  };
  for (const narrow of [false, true]) {
    if (bandTotal(families, all, cwMin, narrow) <= room + 0.01) return finish([all], narrow);
  }
  const bands: number[][] = [];
  for (const index of all) {
    const current = bands[bands.length - 1];
    if (current && bandTotal(families, [...current, index], cwMin, true) <= room + 0.01) current.push(index);
    else bands.push([index]);
  }
  return finish(bands, true);
}

function placePill(
  control: { id: string; x: number; w: number },
  lane: { x: number; w: number },
  kind: { kind: string; label: string },
  y: number,
): LayoutPill {
  const maxW = Math.max(40, lane.w - 4);
  const widthPx = Math.min(maxW, Math.max(56, Math.ceil(monoWidth(kind.label, 8.5) + 13)));
  let x = control.x + control.w / 2 - widthPx / 2;
  const minX = lane.x + 1;
  const maxX = lane.x + lane.w - widthPx - 1;
  x = Math.min(Math.max(minX, x), Math.max(minX, maxX));
  return { controlId: control.id, kind: kind.kind, label: kind.label, x, y, w: widthPx, h: PILL_H };
}

function boxesOverlap(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
): boolean {
  return a.x < b.x + b.w - 0.5 && a.x + a.w > b.x + 0.5 && a.y < b.y + b.h - 0.5 && a.y + a.h > b.y + 0.5;
}

/** Stack pills that share a column so none overlaps. `step` is the direction and spacing. */
function stackPills(pills: LayoutPill[], step: number): LayoutPill[] {
  const placed: LayoutPill[] = [];
  for (const pill of pills) {
    const next = { ...pill };
    for (let guard = 0; guard < pills.length + 1; guard += 1) {
      if (!placed.some((other) => boxesOverlap(other, next))) break;
      next.y += step;
    }
    placed.push(next);
  }
  return placed;
}

function portClearOfPills(
  lane: { x: number; w: number },
  pills: Array<{ x: number; y: number; w: number; h: number }>,
  y0: number,
): number {
  const center = lane.x + lane.w / 2;
  const drop = 80;
  const gap = 10;
  const blockers = pills.filter((pill) => {
    const onX = pill.x - 1 < center && center < pill.x + pill.w + 1;
    const onY = pill.y < y0 + drop && pill.y + pill.h > y0 - 2;
    return onX && onY;
  });
  if (blockers.length === 0) return center;
  const left = Math.min(...blockers.map((pill) => pill.x)) - gap;
  const right = Math.max(...blockers.map((pill) => pill.x + pill.w)) + gap;
  const laneLeft = lane.x + FAMILY_PAD;
  const laneRight = lane.x + lane.w - FAMILY_PAD;
  const options = [left, right].filter((value) => value >= laneLeft && value <= laneRight);
  if (options.length === 0) return Math.min(laneRight, Math.max(laneLeft, center));
  options.sort((a, b) => Math.abs(a - center) - Math.abs(b - center) || a - b);
  return options[0];
}

const EVIDENCE_GAP = 8;
const EVIDENCE_ROW_GAP = 8;
const EVIDENCE_EVEN_GROWTH = 24;

function rowSpan(needs: number[], width: number): number {
  return needs.reduce((sum, need) => sum + Math.max(need, width), 0) + EVIDENCE_GAP * Math.max(0, needs.length - 1);
}

/**
 * Evidence box widths. Every box is at least its own text width and the panel minimum.
 * Boxes share one width when one row has room for it.
 */
function evidenceWidths(needs: number[], minWidth: number, room: number): number[] {
  if (needs.length === 0) return [];
  const widest = Math.min(Math.max(...needs), minWidth + EVIDENCE_EVEN_GROWTH);
  let even = minWidth;
  if (rowSpan(needs, widest) <= room) even = widest;
  else {
    let low = minWidth;
    let high = widest;
    while (high - low > 1) {
      const mid = Math.floor((low + high) / 2);
      if (rowSpan(needs, mid) <= room) low = mid;
      else high = mid;
    }
    even = low;
  }
  return needs.map((need) => Math.max(need, even));
}

/**
 * What a role card must not cover: the role's controls and their flags, the count chips
 * of bundles that touch their families, and the bundle ends on those families' boxes.
 * Wire ends on the controls lie on the control boxes. Pass `bundles` and `pills` as drawn,
 * so hidden layers take no room.
 */
export function roleCardObstacles(
  layout: Pick<ReturnType<typeof buildLayout>, "controls" | "pills" | "bundles" | "lanes">,
  controlIds: string[],
  show: { bundles: boolean; pills: boolean },
): Obstacle[] {
  const linked = new Set(controlIds);
  const controls = layout.controls.filter((control) => linked.has(control.id));
  const families = new Set(controls.map((control) => control.family));
  const boxes = layout.lanes.filter((lane) => families.has(lane.id));
  const out: Obstacle[] = controls.map(({ x, y, w, h }) => ({ x, y, w, h }));
  if (show.pills) out.push(...layout.pills.filter((pill) => linked.has(pill.controlId)).map(({ x, y, w, h }) => ({ x, y, w, h })));
  if (show.bundles) {
    for (const bundle of layout.bundles) {
      if (!families.has(bundle.left) && !families.has(bundle.right)) continue;
      if (bundle.countLabel) out.push({ x: bundle.px - bundle.pw / 2, y: bundle.py - 8, w: bundle.pw, h: 16 });
      const numbers = bundle.d.match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
      if (numbers.length < 4) continue;
      for (const [x, y] of [[numbers[0], numbers[1]], [numbers[numbers.length - 2], numbers[numbers.length - 1]]]) {
        const onLinkedBox = boxes.some((box) => x >= box.x - 2 && x <= box.x + box.w + 2 && y >= box.y - 2 && y <= box.y + box.h + 2);
        if (onLinkedBox) out.push({ x: x - 3, y: y - 3, w: 6, h: 6 });
      }
    }
  }
  return out;
}

/** One evidence box on the map: packages can reuse an evidence id across several boxes, each with its own uuid. */
export function evidenceKey(item: { id: string; uuid: string }): string {
  return `${item.id}|${item.uuid}`;
}

type LaneBox = { id: string; x: number; w: number };
type Placement = "family" | "gap" | "most-links";
type EvidenceItem<T> = { item: T; ideal: number; w: number; need: number; links: Map<string, number> };
type Unit<T> = { items: Array<EvidenceItem<T> & { x: number; placement: Placement; anchor: string }>; left: number; right: number; family: string | null; chunk: number };

/**
 * Where one evidence box belongs, from its links alone. One family: that family. Two
 * families side by side in one band: the gap between them. Otherwise the family with the
 * most linked controls; a tie goes to the leftmost of the tied families (smallest box x,
 * then family order), so the same package always places it the same way.
 */
function evidenceAnchor<T>(entry: EvidenceItem<T>, order: string[], bandOf: Map<string, number>, leftOf: Map<string, number>): EvidenceAnchor {
  const linked = order.map((id, index) => ({ id, index, count: entry.links.get(id) ?? 0 })).filter((item) => item.count > 0);
  if (linked.length <= 1) return { placement: "family", family: linked[0]?.id ?? order[0] };
  const [first, second] = linked;
  if (linked.length === 2 && second.index === first.index + 1 && bandOf.get(first.id) === bandOf.get(second.id)) {
    return { placement: "gap", family: first.id, next: second.id };
  }
  const top = [...linked].sort((a, b) => b.count - a.count
    || (leftOf.get(a.id) ?? 0) - (leftOf.get(b.id) ?? 0)
    || a.index - b.index)[0];
  return { placement: "most-links", family: top.id };
}

type EvidenceAnchor = { placement: Placement; family: string; next?: string };

/** Room under one family that reaches no neighbor box: gap to gap, 12px inside the outer boxes. */
function spanOf(lanes: LaneBox[], index: number): { left: number; right: number } {
  const lane = lanes[index];
  return {
    left: index === 0 ? lane.x + FAMILY_PAD : lanes[index - 1].x + lanes[index - 1].w,
    right: index === lanes.length - 1 ? lane.x + lane.w - FAMILY_PAD : lanes[index + 1].x,
  };
}

/**
 * Evidence rows. Each family's own evidence sits as one centered group under that family,
 * never reaching into a neighbor box (the first and last groups also keep 12px inside the
 * outer boxes); a group too wide for that span breaks into more rows, still centered, and
 * a box wider than the span narrows to it as long as its text still fits. Text wider than
 * the span gives up the outer 12px inset before it reaches a neighbor box, and reaches
 * one only when the canvas leaves no other room.
 * Two-family evidence centers on the gap between its families. Pieces that would touch
 * on one row take the next row down, in family order, so the placement is the same for
 * the same package every time.
 */
function placeEvidence<T extends { id: string; uuid: string }>(
  entries: Array<EvidenceItem<T>>,
  lanes: LaneBox[],
  canvas: { left: number; right: number },
  anchorOf: (entry: EvidenceItem<T>) => EvidenceAnchor,
): Array<EvidenceItem<T> & { x: number; row: number; placement: Placement; anchor: string }> {
  if (lanes.length === 0) return [];
  const byKey = (a: EvidenceItem<T>, b: EvidenceItem<T>) => evidenceKey(a.item).localeCompare(evidenceKey(b.item));
  const units: Array<Unit<T>> = [];
  const groups = new Map<string, Array<EvidenceItem<T> & { placement: Placement }>>();
  for (const lane of lanes) groups.set(lane.id, []);
  for (const entry of entries) {
    const anchor = anchorOf(entry);
    if (anchor.placement === "gap") {
      const left = lanes.find((lane) => lane.id === anchor.family)!;
      const right = lanes.find((lane) => lane.id === anchor.next)!;
      const center = (left.x + left.w + right.x) / 2;
      const x = center - entry.w / 2;
      units.push({
        items: [{ ...entry, x, placement: "gap", anchor: `${left.id}|${right.id}` }],
        left: x,
        right: x + entry.w,
        family: null,
        chunk: 0,
      });
      continue;
    }
    groups.get(anchor.family)!.push({ ...entry, placement: anchor.placement });
  }
  lanes.forEach((lane, index) => {
    const span = spanOf(lanes, index);
    for (const member of groups.get(lane.id) ?? []) {
      if (member.w > span.right - span.left) member.w = Math.max(member.need, Math.floor(span.right - span.left));
    }
  });
  lanes.forEach((lane, index) => {
    const members = (groups.get(lane.id) ?? []).sort((a, b) => a.ideal - b.ideal || byKey(a, b));
    if (members.length === 0) return;
    const { left: spanLeft, right: spanRight } = spanOf(lanes, index);
    const center = lane.x + lane.w / 2;
    const chunks: Array<typeof members> = [];
    for (const member of members) {
      const current = chunks[chunks.length - 1];
      const used = current ? current.reduce((sum, item) => sum + item.w + EVIDENCE_GAP, 0) + member.w : Number.POSITIVE_INFINITY;
      if (current && used <= spanRight - spanLeft + 0.01) current.push(member);
      else chunks.push([member]);
    }
    chunks.forEach((chunk, order) => {
      const width = chunk.reduce((sum, item) => sum + item.w, 0) + EVIDENCE_GAP * (chunk.length - 1);
      const zone = width <= spanRight - spanLeft + 0.01
        ? { left: spanLeft, right: spanRight }
        : {
          left: index === 0 ? canvas.left : spanLeft,
          right: index === lanes.length - 1 ? canvas.right : spanRight,
        };
      const room = width <= zone.right - zone.left + 0.01 ? zone : canvas;
      const start = Math.min(Math.max(center - width / 2, room.left), Math.max(room.left, room.right - width));
      let cursor = start;
      units.push({
        items: chunk.map((item) => {
          const placed = { ...item, x: Math.round(cursor * 100) / 100, anchor: lane.id };
          cursor += item.w + EVIDENCE_GAP;
          return placed;
        }),
        left: start,
        right: start + width,
        family: lane.id,
        chunk: order,
      });
    });
  });
  const laneIndex = new Map(lanes.map((lane, index) => [lane.id, index]));
  units.sort((a, b) => a.chunk - b.chunk
    || a.left - b.left
    || (laneIndex.get(a.family ?? "") ?? -1) - (laneIndex.get(b.family ?? "") ?? -1)
    || evidenceKey(a.items[0].item).localeCompare(evidenceKey(b.items[0].item)));
  const rows: Array<Array<{ left: number; right: number }>> = [];
  const lastRow = new Map<string, number>();
  const placed: Array<EvidenceItem<T> & { x: number; row: number; placement: Placement; anchor: string }> = [];
  for (const unit of units) {
    let row = unit.family ? (lastRow.get(unit.family) ?? -1) + 1 : 0;
    const clear = (index: number) => !(rows[index] ?? []).some((other) => unit.left < other.right + EVIDENCE_GAP - 0.01 && unit.right > other.left - EVIDENCE_GAP + 0.01);
    while (!clear(row)) row += 1;
    (rows[row] ??= []).push({ left: unit.left, right: unit.right });
    if (unit.family) lastRow.set(unit.family, row);
    for (const item of unit.items) placed.push({ ...item, row });
  }
  return placed;
}


const BAND_GAP = 28;

/**
 * Level 1 layout. Each family is a tight box around its header and one row of controls;
 * a family whose header is wider than its controls widens its controls, so every box
 * keeps 12px between its border and its controls. Evidence never widens a box. Families
 * wrap into bands when one row does not fit. Under each band sit its missing pills, its
 * bundles and its evidence rows; bundles between bands route around evidence. Evidence
 * is placed from the package links: under its one family, on the gap of two adjacent
 * families, or under the family it links most.
 */
export function buildLayout(pkg: PackageState, viewWidth: number, panelOpen: boolean, visibleControlIds?: ReadonlySet<string>, showRoles = true, includeBundles = true) {
  const compact = Boolean(visibleControlIds);
  const familyPad = compact ? 8 : FAMILY_PAD;
  const familyGap = compact ? 36 : FAMILY_GAP;
  const visible = compact ? { ...pkg, controls: pkg.controls.filter(control => visibleControlIds!.has(control.id)) } : pkg;
  const evidence = compact ? [] : evidenceNodes(pkg);
  const minEvidence = evidenceWidth(panelOpen);
  const evidenceNeeds = evidence.map((item) => Math.max(minEvidence, evidenceTextWidth(item)));
  const controls = compact ? [...visible.controls].sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true })) : sortedControls(visible);
  const familyFacts = pkg.map.families;
  const order = familyFacts.length
    ? familyFacts.map((family) => family.id)
    : [...new Set(controls.map((control) => control.family))];
  const facts = order.map((id, index) => {
    const fact = familyFacts.find((family) => family.id === id);
    const roll = pkg.families.find((family) => family.id === id);
    const members = controls.filter((control) => control.family === id);
    const title = fact?.title ?? id;
    const moderate = fact?.moderateBase ?? null;
    const within = fact?.withinPairs ?? 0;
    const incomplete = roll?.open ?? members.filter((control) => !control.complete).length;
    const total = roll?.total ?? members.length;
    const linked = pkg.controls.filter(control => control.family === id && control.rollupState === "recorded").length;
    const countText = compact ? "" : roll?.summary ?? familyCountText(incomplete, total);
    const open = roll?.summary ? 0 : incomplete;
    const baselineText = compact ? `${linked} linked · ${total - linked} blank` : familyBaselineText(members.length, moderate, within);
    const text = { id, title, countText, baselineText };
    return {
      id,
      index,
      title,
      titleLines: compact ? COVERAGE_FAMILY_LINES[id] ?? familyLines(title) : familyLines(title),
      countText,
      baselineText,
      moderate,
      within,
      open,
      total,
      members,
      header: compact ? 54 : familyHeaderWidth(text),
      narrow: compact ? 54 : familyHeaderWidth(text, true),
    };
  });
  const cwMin = compact ? 54 : Math.max(
    CONTROL_FLOOR,
    ...controls.map((control) => controlFaceWidth({ id: control.id, title: control.title, status: controlFaceStatus(control) })),
  );
  const cwMax = compact ? 54 : Math.max(CONTROL_MAX, cwMin);
  const room = Math.max(200, viewWidth - (compact ? 56 : 32));
  const inputs: FamilyInput[] = facts.map((fact) => ({ id: fact.id, members: compact ? Math.ceil(fact.members.length / 2) : fact.members.length, header: fact.header, narrow: fact.narrow }));
  const plan = compact
    ? (() => {
      const bands = [inputs.slice(0, 9).map((_, i) => i), inputs.slice(9).map((_, i) => i + 9)].filter(band => band.length);
      let cw=54;
      while(cw>24 && bands.some(band=>bandTotal(inputs,band,cw,true,true)>room))cw-=0.5;
      return { bands, cw, narrow: true, totals: bands.map(band => bandTotal(inputs, band, cw, true, true)) };
    })()
    : planBands(inputs, room, cwMin, cwMax);
  const width = Math.max(viewWidth, Math.ceil((compact ? 56 : 32) + Math.max(...plan.totals, 0)));
  const bandOf = new Map<string, number>();
  plan.bands.forEach((band, b) => band.forEach((index) => bandOf.set(facts[index].id, b)));

  const roleList = compact && !showRoles ? [] : roleNodes(visible);
  const roleItemsW = roleList.map((role) => roleWidth(role.label));
  const roleNeed = roleItemsW.reduce((sum, w) => sum + w, 0) + 8 * Math.max(0, roleItemsW.length - 1);
  const twoRoleRows = roleNeed > width - 32 + 0.5 && roleList.length >= 2;
  const rolesBottom = roleList.length === 0 ? ROLE_Y : (twoRoleRows ? ROLE2_Y : ROLE_Y) + ROLE_H;

  const lanes: LayoutLane[] = [];
  const layoutControls: LayoutControl[] = [];
  const pills: LayoutPill[] = [];
  let bundles: Array<ReturnType<typeof bundleShape>> = [];
  const evidenceBoxes: Array<ReturnType<typeof evidenceNodes>[number] & { x: number; y: number; w: number; h: number; row: number; band: number; host: string; placement: Placement; displaced: boolean }> = [];
  const bands: Array<{ top: number; boxTop: number; boxBottom: number; controlY: number; evidenceY: number; bottom: number }> = [];
  const boxWidths = evidenceWidths(evidenceNeeds, minEvidence, room);
  const entryOf = (item: (typeof evidence)[number], index: number, familyOfControl: Map<string, string>) => ({
    item,
    ideal: 0,
    w: boxWidths[index],
    need: evidenceTextWidth(item),
    links: item.controlIds.reduce((map, id) => {
      const family = familyOfControl.get(id);
      if (family) map.set(family, (map.get(family) ?? 0) + 1);
      return map;
    }, new Map<string, number>()),
  });
  const familyOfControl = new Map(controls.map((control) => [control.id, control.family]));
  const entries = evidence.map((item, index) => entryOf(item, index, familyOfControl));
  const leftOf = new Map<string, number>();
  plan.bands.forEach((band, b) => {
    let x = compact ? 28 : 16 + Math.max(0, (width - (compact ? 56 : 32) - plan.totals[b]) / 2);
    for (const index of band) {
      leftOf.set(facts[index].id, x);
      x += boxWidth(plan.narrow ? inputs[index].narrow : inputs[index].header, inputs[index].members, plan.cw, compact) + familyGap + (compact ? Math.max(0, width - (compact ? 56 : 32) - plan.totals[b]) / band.length : 0);
    }
  });
  const anchors = new Map(entries.map((entry) => [entry, evidenceAnchor(entry, facts.map((fact) => fact.id), bandOf, leftOf)]));
  const visibleFamilyPairs = new Set(pkg.map.edges.flatMap(edge => {
    const left = familyOfControl.get(edge.fromId), right = familyOfControl.get(edge.toId);
    return left && right && left !== right ? [[left, right].sort().join("|")] : [];
  }));
  const bundleSource = includeBundles ? pkg.map.bundles.filter(bundle => !compact || visibleFamilyPairs.has([bundle.left, bundle.right].sort().join("|"))).sort((a, b) => b.pairs - a.pairs || a.left.localeCompare(b.left) || a.right.localeCompare(b.right)) : [];

  let cursorY = compact && roleList.length === 0 ? -ROLE_TO_BOX + 6 : rolesBottom;
  plan.bands.forEach((band, b) => {
    const bandFacts = band.map((index) => facts[index]);
    const rolePills = bandFacts.some((fact) => fact.members.some((control) => control.missing.includes("responsibleRole")));
    const boxTop = cursorY + (b === 0 ? (rolePills ? ROLE_PILL_BAND : ROLE_TO_BOX) : (compact ? 22 : BAND_GAP) + (rolePills ? ROLE_PILL_BAND - ROLE_TO_BOX : 0));
    const widths = band.map((index) => boxWidth(plan.narrow ? inputs[index].narrow : inputs[index].header, inputs[index].members, plan.cw, compact) + (compact ? Math.max(0, width - (compact ? 56 : 32) - plan.totals[b]) / band.length : 0));
    const headers = bandFacts.map((fact, i) => {
      const inner = widths[i] - 2 * familyPad;
      const oneLine = manropeWidth(fact.title, 8.5, 400) <= inner - 2;
      const wholeBaseline = fact.header <= inner;
      return { oneLine, wholeBaseline };
    });
    const twoTitleLines = compact || headers.some((header) => !header.oneLine);
    const splitBaselines = compact || headers.some((header) => !header.wholeBaseline);
    const headerH = compact ? 54 : familyHeaderHeight(twoTitleLines ? 2 : 1, splitBaselines ? 2 : 1);
    const controlY = boxTop + familyPad + headerH + FAMILY_HEADER_GAP;
    const controlH = compact ? Math.max(76,...bandFacts.flatMap(fact=>fact.members.map(control=>controlBlockHeight(pkg.map.statements[control.id]?.items.length??0,54,62)))) : CONTROL_H;
    const boxH = familyPad + headerH + FAMILY_HEADER_GAP + (compact ? 2 * controlH + 16 + 42 : controlH) + familyPad;
    const boxBottom = boxTop + boxH;
    let cursorX = compact ? 28 : 16 + Math.max(0, (width - (compact ? 56 : 32) - plan.totals[b]) / 2);
    const bandLanes: LayoutLane[] = bandFacts.map((fact, i) => {
      const w = widths[i];
      const titleLines: [string, string] = compact ? fact.titleLines : twoTitleLines && fact.titleLines[1] ? fact.titleLines : [fact.title, ""];
      const baselineLines: [string, string] = compact ? [fact.baselineText.split(" · ")[0], fact.baselineText.split(" · ")[1]] : splitBaselines ? splitBaseline(fact.baselineText) : [fact.baselineText, ""];
      const lane: LayoutLane = {
        id: fact.id,
        title: fact.title,
        titleLines,
        countText: fact.countText,
        baselineText: fact.baselineText,
        baselineLines,
        headerH,
        moderate: fact.moderate,
        within: fact.within,
        open: fact.open,
        total: fact.total,
        memberIds: fact.members.map((control) => control.id),
        x: Math.round(cursorX * 100) / 100,
        y: boxTop,
        w,
        h: boxH,
        band: b,
        alt: fact.index % 2 === 1,
      };
      cursorX += w + familyGap;
      const count = fact.members.length;
      const columns = compact ? Math.max(1, Math.ceil(count / 2)) : count;
      const cw = compact ? plan.cw : count > 0 ? (w - 2 * familyPad - (columns - 1) * CONTROL_GAP) / columns : plan.cw;
      fact.members.forEach((control, slot) => {
        layoutControls.push({
          id: control.id,
          title: control.title,
          family: control.family,
          complete: control.complete,
          missing: control.missing,
          x: Math.round((lane.x + familyPad + (compact ? Math.max(0, w - 2 * familyPad - columns * cw - (columns - 1) * CONTROL_GAP) / 2 : 0) + (compact ? Math.floor(slot / 2) : slot) * (cw + CONTROL_GAP)) * 100) / 100,
          y: controlY + (compact ? (slot % 2) * (controlH + 16) : 0),
          w: Math.round(cw * 100) / 100,
          h: compact ? controlBlockHeight(pkg.map.statements[control.id]?.items.length??0,cw,62) : controlH,
        });
      });
      return lane;
    });
    lanes.push(...bandLanes);
    const above: LayoutPill[] = [];
    const below: LayoutPill[] = [];
    for (const control of layoutControls.filter((item) => bandOf.get(item.family) === b)) {
      const lane = bandLanes.find((item) => item.id === control.family)!;
      control.missing.forEach((field) => {
        const kind = { kind: field === "responsibleRole" ? "role" : field === "implementation" ? "impl" : "evidence", label: gapLabel(field) };
        if (kind.kind === "role") above.push(placePill(control, lane, kind, boxTop - PILL_GAP - PILL_H));
        else below.push(placePill(control, lane, kind, boxBottom + PILL_GAP));
      });
    }
    const bandPills = [...stackPills(above, -(PILL_H + 4)), ...stackPills(below, PILL_H + 4)];
    pills.push(...bandPills);
    const pillBottom = bandPills.reduce((max, pill) => Math.max(max, pill.y + pill.h), boxBottom);
    const ports = new Map(bandLanes.map((lane) => [lane.id, portClearOfPills(lane, bandPills, boxBottom)]));
    const inBand = bundleSource.filter((bundle) => ports.has(bundle.left) && ports.has(bundle.right));
    const rank = new Map(
      inBand
        .map((bundle) => ({ key: `${bundle.left}|${bundle.right}`, span: Math.abs(ports.get(bundle.left)! - ports.get(bundle.right)!) }))
        .sort((x, y) => x.span - y.span || x.key.localeCompare(y.key))
        .map((item, index) => [item.key, index] as const),
    );
    const bandBundles = inBand.map((bundle) => bundleShape(bundle, ports.get(bundle.left)!, ports.get(bundle.right)!, boxBottom, compact ? 0 : rank.get(`${bundle.left}|${bundle.right}`) ?? 0));
    bundles.push(...bandBundles);
    const bundleBottom = bandBundles.reduce((max, bundle) => Math.max(max, bundle.py + 10), boxBottom);
    const single = plan.bands.length === 1;
    const evidenceY = Math.max(single && pillBottom + 12 <= EVIDENCE_Y ? EVIDENCE_Y : 0, bundleBottom + 18, pillBottom + 16);
    const bandEntries = entries.filter((entry) => bandOf.get(anchors.get(entry)!.family) === b);
    const placed = placeEvidence(bandEntries, bandLanes, { left: 16, right: width - 16 }, (entry) => anchors.get(entry)!);
    for (const slot of placed) {
      evidenceBoxes.push({
        ...slot.item,
        x: slot.x,
        y: evidenceY + slot.row * (EVIDENCE_H + EVIDENCE_ROW_GAP),
        w: slot.w,
        h: EVIDENCE_H,
        row: slot.row,
        band: b,
        host: slot.anchor,
        placement: slot.placement,
        displaced: false,
      });
    }
    const rows = placed.reduce((max, slot) => Math.max(max, slot.row + 1), 0);
    const bottom = compact ? boxBottom : (rows > 0 ? evidenceY + rows * (EVIDENCE_H + EVIDENCE_ROW_GAP) - EVIDENCE_ROW_GAP : Math.max(bundleBottom, pillBottom));
    bands.push({ top: cursorY, boxTop, boxBottom, controlY, evidenceY, bottom });
    cursorY = bottom;
  });

  const laneById = new Map(lanes.map((lane) => [lane.id, lane]));
  const obstacles = [
    ...lanes,
    ...pills,
    ...evidenceBoxes,
  ];
  const crossBand = bundleSource.filter((bundle) => bandOf.get(bundle.left) !== bandOf.get(bundle.right));
  crossBand.forEach((bundle, index) => {
    const [upper, lower] = [laneById.get(bundle.left)!, laneById.get(bundle.right)!].sort((a, b) => a.band - b.band || a.x - b.x);
    const gapTop = bands[lower.band - 1].bottom;
    const gapY = gapTop + 6 + (index % 4) * 4;
    bundles.push(crossBandShape(bundle, upper, lower, gapY, obstacles.filter((item) => item !== upper && item !== lower), index, width));
  });
  bundles = placeBundleChips(bundles, { left: 16, right: width - 16 }, [...lanes, ...pills, ...layoutControls, ...evidenceBoxes]);

  const center = new Map(layoutControls.map((control) => [control.id, control.x + control.w / 2]));
  const roleItems = roleList.map((role, index) => ({
    id: role.id,
    w: roleItemsW[index],
    ideal: mean(role.controlIds.map((id) => center.get(id) ?? width / 2)),
  }));
  const placedRoles = twoRoleRows
    ? splitRows(roleItems, { left: 16, right: width - 16 }, ROLE_Y, ROLE2_Y, 8)
    : placeOneRow(roleItems, { left: 16, right: width - 16 }, ROLE_Y, 8);
  const roleBoxes = placedRoles.map((placed) => {
    const role = roleList.find((item) => item.id === placed.id)!;
    return { ...role, x: placed.x, y: placed.y, w: placed.w, h: ROLE_H };
  });
  const last = bands[bands.length - 1];
  const height = Math.max(LAYOUT_HEIGHT, (last?.bottom ?? rolesBottom) + 16);
  return {
    width,
    lanes,
    controls: layoutControls,
    roles: roleBoxes,
    evidence: evidenceBoxes,
    evidenceRows: evidenceBoxes.reduce((max, box) => Math.max(max, box.row + 1), 0),
    pills,
    bundles,
    bands,
    height,
    controlY: bands[0]?.controlY ?? rolesBottom,
    rolesBottom,
    boxTop: bands[0]?.boxTop ?? rolesBottom,
    evidenceY: bands[0]?.evidenceY ?? EVIDENCE_Y,
  };
}

type Point = { x: number; y: number };
type Rect = { x: number; y: number; w: number; h: number };
type Obstacle = { x: number; y: number; w: number; h: number };

/**
 * A line between bands. It leaves (x1, y1) on the upper band, slides to the nearest column
 * that no box, pill or evidence box occupies (the canvas margins always qualify), drops
 * through it to `gapY` above the lower band, runs across that gap and ends at (x2, y2) on
 * the lower band, turning at right angles. `reverse` draws the same line from the lower end, for arrowheads.
 * `run` is the stretch across the gap, where a count chip sits.
 */
function crossBandRoute(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  gapY: number,
  obstacles: Obstacle[],
  canvasWidth: number,
  reverse = false,
): { d: string; run: Point[]; drop: [Point, Point] } {
  const jog = y1 + 14;
  const margin = 2.5;
  const blocked = (x: number) => obstacles.some((item) => item.y < gapY && item.y + item.h > jog
    && x > item.x - margin && x < item.x + item.w + margin);
  let drop = x1;
  for (let step = 0; step <= canvasWidth; step += 1) {
    if (x1 - step >= 6 && !blocked(x1 - step)) { drop = x1 - step; break; }
    if (x1 + step <= canvasWidth - 6 && !blocked(x1 + step)) { drop = x1 + step; break; }
  }
  const run: Point[] = [{ x: drop, y: gapY }, { x: x2, y: gapY }];
  const route = [{ x: x1, y: y1 }, { x: x1, y: y1 + 7 }, { x: drop, y: y1 + 7 }, { x: drop, y: gapY }, { x: x2, y: gapY }, { x: x2, y: y2 }]
    .filter((point, index, all) => index === 0 || point.x !== all[index - 1].x || point.y !== all[index - 1].y);
  return { d: treePath(reverse ? route.reverse() : route), run, drop: [{ x: drop, y: jog }, { x: drop, y: gapY - 6 }] };
}

/** A bundle between families in different bands, routed around evidence. */
function crossBandShape(
  bundle: PackageState["map"]["bundles"][number],
  upper: LayoutLane,
  lower: LayoutLane,
  gapY: number,
  obstacles: Obstacle[],
  index: number,
  canvasWidth: number,
) {
  const spread = ((index % 3) - 1) * 6;
  const route = crossBandRoute(upper.x + upper.w / 2 + spread, upper.y + upper.h, lower.x + lower.w / 2 + spread, lower.y, gapY, obstacles, canvasWidth);
  const chip = pointAlong(route.run, 0.5);
  return { ...bundle, d: route.d, run: route.run, drop: route.drop, px: chip.x, py: chip.y, pw: bundle.pairs >= 10 ? 30 : 22, countLabel: bundleCountBadge(bundle.pairs) };
}

/**
 * Count chips stay on their own arc. A chip that would overlap a chip already placed (bigger
 * bundles first), a pill, a control or an evidence box slides along its arc away from the
 * middle, to the nearest free spot, then up the straight drop of a route between bands; with
 * none free it takes the spot with the least overlap.
 */
function placeBundleChips<T extends { px: number; py: number; pw: number; pairs: number; left: string; right: string; countLabel: string | null; run: Point[]; drop?: [Point, Point] }>(
  bundles: T[],
  bounds: { left: number; right: number },
  obstacles: Rect[],
): T[] {
  const height = 16;
  const placed: Rect[] = [];
  const order = [...bundles].sort((a, b) => b.pairs - a.pairs || a.left.localeCompare(b.left) || a.right.localeCompare(b.right));
  const steps = [0.5];
  for (let k = 1; k <= 22; k += 1) steps.push(0.5 - k * 0.02, 0.5 + k * 0.02);
  const overlap = (a: Rect, b: Rect) => Math.max(0, Math.min(a.x + a.w, b.x + b.w + 2) - Math.max(a.x, b.x - 2))
    * Math.max(0, Math.min(a.y + a.h, b.y + b.h + 2) - Math.max(a.y, b.y - 2));
  const chips = new Map<T, Point>();
  for (const bundle of order) {
    if (!bundle.countLabel) continue;
    const rect = (point: Point) => ({ x: point.x - bundle.pw / 2, y: point.y - height / 2, w: bundle.pw, h: height });
    let best: { point: Point; cost: number } | null = null;
    const candidates = steps.map((t) => pointAlong(bundle.run, t));
    if (bundle.drop) {
      const [top, bottom] = bundle.drop;
      for (let y = bottom.y - height / 2 - 2; y >= top.y + height / 2; y -= 4) candidates.push({ x: bottom.x, y });
    }
    for (const point of candidates) {
      const box = rect(point);
      if (box.x < bounds.left || box.x + box.w > bounds.right) continue;
      const cost = [...placed, ...obstacles].reduce((sum, other) => sum + overlap(box, other), 0);
      if (!best || cost < best.cost) best = { point, cost };
      if (cost === 0) break;
    }
    const point = best?.point ?? pointAlong(bundle.run, 0.5);
    placed.push(rect(point));
    chips.set(bundle, point);
  }
  return bundles.map((bundle) => {
    const point = chips.get(bundle);
    return point ? { ...bundle, px: point.x, py: point.y } : bundle;
  });
}

/** One bundle arc between two box bottoms in the same band, dipping below them. */
function bundleShape(
  bundle: PackageState["map"]["bundles"][number],
  x1: number,
  x2: number,
  y: number,
  rank: number,
) {
  const depth = bundleDepth(x1, x2, rank);
  const run: Point[] = [{ x: x1, y }, { x: x1, y: y + depth }, { x: x2, y: y + depth }, { x: x2, y }];
  const point = pointAlong(run, 0.5);
  return { ...bundle, d: treePath(run), run, px: point.x, py: point.y, pw: bundle.pairs >= 10 ? 30 : 22, countLabel: bundleCountBadge(bundle.pairs) };
}

function splitRows(
  items: Array<{ id: string; w: number; ideal: number }>,
  bounds: { left: number; right: number },
  rowY: number,
  row2Y: number,
  gap: number,
) {
  const sorted = [...items].sort((a, b) => a.ideal - b.ideal || a.id.localeCompare(b.id));
  const need = sorted.reduce((sum, item) => sum + item.w, 0) + gap * Math.max(0, sorted.length - 1);
  let used = 0;
  let split = Math.max(1, Math.ceil(sorted.length / 2));
  for (let index = 0; index < sorted.length - 1; index += 1) {
    used += sorted[index].w + gap;
    if (used >= need / 2) {
      split = index + 1;
      break;
    }
  }
  return [
    ...placeOneRow(sorted.slice(0, split), bounds, rowY, gap),
    ...placeOneRow(sorted.slice(split), bounds, row2Y, gap),
  ];
}
