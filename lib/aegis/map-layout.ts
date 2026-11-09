/** Level 1 geometry. One CSS pixel equals one SVG unit. Every connector is a right-angled route; see selected-tree. */

export const LAYOUT_HEIGHT = 570;
export const CONTROL_Y = 200;
export const CONTROL_H = 88;
export const ROLE_Y = 68;
export const ROLE_H = 40;
export const ROLE2_Y = 114;
export const EVIDENCE_Y = 456;
export const EVIDENCE_H = 48;
export const EVIDENCE2_Y = 512;
/** Tight family box: padding on all four sides and gap between boxes. */
export const FAMILY_PAD = 12;
export const FAMILY_GAP = 8;
/** Header block to control row. */
export const FAMILY_HEADER_GAP = 12;
/** Box top below the roles row when no control shows a role pill, and when one does. */
export const ROLE_TO_BOX = 18;
export const ROLE_PILL_BAND = 32;

/**
 * Display override for the sample demo boxes so they keep their designed size.
 * Applied only when the catalog title is the one the abbreviation was written for.
 * Not a title source. Every other title uses faceLines.
 */
const SHORT_FOR: Record<string, { title: string; lines: [string, string] }> = {
  "AC-2": { title: "Account Management", lines: ["Account", "Mgmt"] },
  "AC-3": { title: "Access Enforcement", lines: ["Access", "Enforce"] },
  "AC-6": { title: "Least Privilege", lines: ["Least", "Privilege"] },
  "AU-2": { title: "Event Logging", lines: ["Event", "Logging"] },
  "AU-6": { title: "Audit Record Review, Analysis, and Reporting", lines: ["Audit", "Review"] },
  "CM-2": { title: "Baseline Configuration", lines: ["Baseline", "Config"] },
  "CM-6": { title: "Configuration Settings", lines: ["Config", "Settings"] },
  "IA-2": { title: "Identification and Authentication (Organizational Users)", lines: ["Identify", "& Auth"] },
  "IA-5": { title: "Authenticator Management", lines: ["Authenticator", "Mgmt"] },
  "SC-7": { title: "Boundary Protection", lines: ["Boundary", "Protect"] },
  "SC-8": { title: "Transmission Confidentiality and Integrity", lines: ["Transmit", "Confid."] },
  "SI-2": { title: "Flaw Remediation", lines: ["Flaw", "Remediate"] },
};

/** Two-line faces for the sample ids. faceLines applies one only when the title matches. */
export const SHORT_TITLE: Record<string, [string, string]> = Object.fromEntries(
  Object.entries(SHORT_FOR).map(([id, row]) => [id, row.lines]),
);

/**
 * Two lines for a control face. Never inserts an ellipsis.
 * A known demo id uses SHORT_TITLE only when `title` is the catalog title that
 * abbreviation was written for. Every other title drops parentheticals, then
 * splits on spaces so the two lines are as even as possible.
 * The full catalog title stays in the tooltip, the aria-label, and the panel.
 */
export function faceLines(id: string, title: string): [string, string] {
  const known = SHORT_FOR[id];
  if (known && known.title.toLowerCase() === title.trim().toLowerCase()) return known.lines;
  const stripped = title.replace(/\s*\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
  const words = (stripped || title).split(" ").filter(Boolean);
  if (words.length === 0) return [title, ""];
  if (words.length === 1) return [words[0], ""];
  let best = 1;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let index = 1; index < words.length; index += 1) {
    const left = words.slice(0, index).join(" ").length;
    const right = words.slice(index).join(" ").length;
    const score = Math.abs(left - right);
    if (score < bestScore) {
      bestScore = score;
      best = index;
    }
  }
  return [words.slice(0, best).join(" "), words.slice(best).join(" ")];
}

export function num(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  if (Object.is(rounded, -0)) return "0";
  return String(rounded);
}

/** Depth of a family bundle's run below the frames it joins. */
export function bundleDepth(x1: number, x2: number, rank = 0): number {
  return Math.min(72, 12 + 0.08 * Math.abs(x2 - x1)) + rank * 8;
}

/** Point a fraction `t` of the way along a route, by length. */
export function pointAlong(route: Array<{ x: number; y: number }>, t: number): { x: number; y: number } {
  const lengths = route.slice(1).map((point, index) => Math.abs(point.x - route[index].x) + Math.abs(point.y - route[index].y));
  let left = lengths.reduce((sum, value) => sum + value, 0) * Math.max(0, Math.min(1, t));
  for (let index = 0; index < lengths.length; index += 1) {
    if (left <= lengths[index] && lengths[index] > 0) {
      const a = route[index], b = route[index + 1], f = left / lengths[index];
      return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
    }
    left -= lengths[index];
  }
  return route.at(-1) ?? { x: 0, y: 0 };
}

export function spread(origin: number, size: number, count: number, index: number, fraction: number): number {
  if (count <= 1) return origin + size / 2;
  const span = size * fraction;
  const start = origin + (size - span) / 2;
  return start + (span * index) / (count - 1);
}

export type Box = { x: number; y: number; w: number; h: number };

/** Role chip width: its label on one line (10.5px 800, 8px side padding, 1px border), at least 112px. */
export function roleWidth(label: string): number {
  return Math.max(112, Math.ceil(manropeWidth(label, 10.5, 800) + 20));
}

export function controlWidth(laneWidth: number, count: number): number {
  if (count <= 0) return 88;
  return Math.min(88, (laneWidth - 12 - 8 * (count - 1)) / count);
}

/** Minimum evidence box width. Boxes grow to fit their text and never shrink below this. */
export function evidenceWidth(panelOpen: boolean): number {
  return panelOpen ? 100 : 124;
}

export function evidenceDisplayTitle(title: string): string {
  return title.replace(/\bconfiguration\b/gi, "config");
}

/**
 * Whole-pixel advances of Manrope at 8.5px for ASCII 32 to 126, as hinted Chromium
 * lays out each glyph. Title is weight 700 and meta is 650, matching the card CSS.
 * Subpixel renderers draw the same text narrower, so these are upper bounds.
 */
const TITLE_GLYPHS = "23585863445534346456655666335655856765577356587767667758657344665555663653353755564646575564346";
const META_GLYPHS = "23585863445534346456555566335655866765577356587767665758656344665555653653353756564646575564346";

function cardTextWidth(text: string, glyphs: string): number {
  let sum = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code >= 32 && code <= 126) sum += Number(glyphs[code - 32]);
    else if (char === "·") sum += 2;
    else sum += 9;
  }
  return sum;
}

/** Manrope 400 advances in thousandths of an em for ASCII 32 to 126, rounded up. */
const MANROPE_400 = [
  200, 314, 392, 921, 589, 902, 652, 214, 426, 426, 437, 577, 266, 420, 254, 388, 610, 390, 570, 553, 590, 578, 621, 502,
  581, 621, 299, 306, 615, 750, 615, 524, 904, 634, 613, 716, 672, 570, 504, 705, 685, 234, 464, 594, 511, 841, 685, 724,
  604, 724, 631, 617, 597, 702, 604, 936, 606, 556, 614, 407, 388, 407, 670, 660, 490, 556, 592, 554, 593, 585, 355, 592,
  594, 234, 251, 496, 234, 848, 594, 592, 592, 593, 361, 525, 401, 594, 508, 768, 527, 528, 530, 420, 254, 420, 662,
];

function regularWidth(text: string, px: number): number {
  let sum = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    sum += code >= 32 && code <= 126 ? MANROPE_400[code - 32] : char === "·" ? 254 : 1000;
  }
  return (sum * px) / 1000;
}

/**
 * Manrope width at any size. Regular text uses the 400 advances. Weight 700 and up uses
 * the title advances and lighter bold the meta advances, both upper bounds.
 */
export function manropeWidth(text: string, px: number, weight = 650): number {
  if (weight < 600) return regularWidth(text, px);
  const base = cardTextWidth(text, weight >= 700 ? TITLE_GLYPHS : META_GLYPHS) * (px / 8.5);
  return weight >= 800 ? base * 1.04 : base;
}

/** JetBrains Mono advances are 0.6em for every glyph. */
export function monoWidth(text: string, px: number): number {
  return [...text].length * px * 0.6;
}

/** Family title on at most two lines, split at the middle word. */
export function familyLines(title: string): [string, string] {
  const words = title.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [title, ""];
  if (words.length <= 2) return [words[0] ?? title, words.slice(1).join(" ")];
  const mid = Math.ceil(words.length / 2);
  return [words.slice(0, mid).join(" "), words.slice(mid).join(" ")];
}

export function gapLabel(field: string): string {
  if (field === "responsibleRole") return "✕ role";
  if (field === "implementation") return "✕ impl";
  return "✕ evidence";
}

/** Status line on a control face. */
export function controlStatusText(missing: string[]): string {
  if (missing.length === 0) return "✓ complete";
  if (missing.length > 1) return `✕ ${missing.length} missing`;
  return gapLabel(missing[0]);
}

/** Face status. A rollup control is Blank or Recorded, never a completeness pass. */
export function controlFaceStatus(control: { missing: string[]; rollupState?: "blank" | "recorded" }): string {
  if (control.rollupState === "blank") return "Blank";
  if (control.rollupState === "recorded") return "Recorded";
  return controlStatusText(control.missing);
}

export function familyCountText(open: number, total: number): string {
  return open > 0 ? `${open} of ${total} open` : `${total} ok`;
}

export function familyBaselineText(members: number, moderate: number | null, within: number): string {
  const head = moderate != null ? `${members}/${moderate} Moderate` : `${members} in subset`;
  return within > 0 ? `${head} · ${within} within` : head;
}

const HEADER_SLACK = 4;

/** Baseline line split at its middle dot, for a narrow box. One part when there is no dot. */
export function splitBaseline(text: string): [string, string] {
  const at = text.indexOf(" · ");
  return at < 0 ? [text, ""] : [text.slice(0, at), text.slice(at + 1)];
}

/**
 * Width the family header needs so every line shows whole: the id and open count (13px
 * 800 and 9px 700), the title on at most two lines (8.5px), and the baseline line (mono
 * 8px). With `narrow`, the baseline may break at its middle dot onto a second line.
 */
export function familyHeaderWidth(
  family: { id: string; title: string; countText: string; baselineText: string },
  narrow = false,
): number {
  const [line1, line2] = familyLines(family.title);
  const top = manropeWidth(family.id, 13, 800) + 6 + manropeWidth(family.countText, 9, 700);
  const baseline = narrow ? splitBaseline(family.baselineText) : [family.baselineText];
  return Math.ceil(Math.max(
    top,
    manropeWidth(line1, 8.5, 400),
    manropeWidth(line2, 8.5, 400),
    ...baseline.map((line) => monoWidth(line, 8)),
  )) + HEADER_SLACK;
}

/** Header block height: 18px id row (the 13px id's full line box) plus 1px, 10px per title line, 2px, 11px per baseline line. */
export function familyHeaderHeight(titleLines: number, baselineLines: number): number {
  return 21 + 10 * titleLines + 11 * baselineLines;
}

/**
 * Narrowest control face that shows its id and status line whole and no title word cut.
 * Title lines wrap at spaces inside the face.
 */
export function controlFaceWidth(control: { id: string; title: string; status: string }): number {
  const words = faceLines(control.id, control.title).join(" ").split(/\s+/).filter(Boolean);
  return Math.ceil(Math.max(
    monoWidth(control.id, 11.5),
    ...words.map((word) => manropeWidth(word, 9, 400)),
    manropeWidth(control.status, 8.5, 800),
  ) + FACE_PADDING);
}

/** Control face side padding (4px each side) plus a pixel for subpixel rounding. */
const FACE_PADDING = 9;

/** Role and evidence card width, gap to the row it points at, and canvas margin. */
export const CARD_W = 320;
export const CARD_GAP = 12;
export const CARD_MARGIN = 12;

function cardLeft(box: Box, canvasWidth: number, cardW: number): { left: number; caretX: number } {
  const center = box.x + box.w / 2;
  const left = Math.max(CARD_MARGIN, Math.min(center - cardW / 2, canvasWidth - CARD_MARGIN - cardW));
  return { left, caretX: Math.max(16, Math.min(cardW - 16, center - left)) };
}

type Span = { x: number; y: number; w: number; h: number };

/**
 * Evidence card below the clicked box's row, centered under it and clamped in the canvas.
 * When a box on a lower evidence row sits under that spot, the card slides sideways as
 * far as its caret can still point at the clicked box; failing that it drops below the
 * lowest such row. Evidence rows are the lowest things with wires, so the card covers no
 * box and no wire end. The caller grows the canvas when the band under the row is short.
 */
export function evidenceCardSpot(box: Box, rowBottom: number, canvasWidth: number, cardW: number, cardH: number, lower: Span[] = []) {
  const center = box.x + box.w / 2;
  const top = rowBottom + CARD_GAP;
  const clear = (left: number) => !lower.some((item) => item.y >= rowBottom - 0.5 && item.y < top + cardH
    && item.x < left + cardW - 0.5 && item.x + item.w > left + 0.5);
  const lowest = Math.max(CARD_MARGIN, Math.min(center - cardW + 16, canvasWidth - CARD_MARGIN - cardW));
  const highest = Math.min(canvasWidth - CARD_MARGIN - cardW, Math.max(CARD_MARGIN, center - 16));
  const ideal = cardLeft(box, canvasWidth, cardW).left;
  const options = [ideal];
  for (let shift = 1; shift <= cardW; shift += 1) options.push(ideal - shift, ideal + shift);
  const left = options.find((value) => value >= lowest - 0.01 && value <= highest + 0.01 && clear(value));
  if (left != null) return { left, top, bottom: top + cardH, caretX: Math.max(16, Math.min(cardW - 16, center - left)) };
  const under = lower.filter((item) => item.y >= rowBottom - 0.5 && item.x < ideal + cardW && item.x + item.w > ideal);
  const dropped = Math.max(rowBottom, ...under.map((item) => item.y + item.h)) + CARD_GAP;
  return { left: ideal, top: dropped, bottom: dropped + cardH, caretX: Math.max(16, Math.min(cardW - 16, center - ideal)) };
}

/** How far the caret sits from a body edge and still meets the straight part of the card's top edge. */
export const CARET_INSET = 18;

/**
 * Role card laid over the map, 12px under its role chip. Nothing on the map moves. The
 * caret is always centered on the chip; only the body slides sideways, clamped 12px inside
 * the canvas, to the nearest spot clear of everything the role links to (`linked`, from
 * `roleCardObstacles`). It may cover dimmed, unlinked content. When the body no longer spans the
 * caret, a leader along its top edge joins the two. When no spot clears the linked items at
 * full height, it takes the spot that leaves it tallest and scrolls inside (`maxHeight`).
 */
export function roleCardSpot(role: Box, canvasWidth: number, cardW: number, cardH: number, linked: Span[]) {
  const top = role.y + role.h + CARD_GAP;
  const center = role.x + role.w / 2;
  const lowest = CARD_MARGIN;
  const highest = Math.max(CARD_MARGIN, canvasWidth - CARD_MARGIN - cardW);
  const ideal = Math.max(lowest, Math.min(center - cardW / 2, highest));
  const clearance = 2;
  const room = (left: number) => linked
    .filter((item) => item.x < left + cardW + clearance && item.x + item.w > left - clearance && item.y + item.h > top - clearance)
    .reduce((height, item) => Math.min(height, item.y - clearance - top), cardH);
  const options = [ideal];
  for (let shift = 1; shift <= canvasWidth; shift += 1) {
    if (ideal - shift >= lowest) options.push(ideal - shift);
    if (ideal + shift <= highest) options.push(ideal + shift);
  }
  let left = ideal;
  let height = room(ideal);
  for (const option of options) {
    const fit = room(option);
    if (fit >= cardH) {
      left = option;
      height = cardH;
      break;
    }
    if (fit > height) {
      left = option;
      height = fit;
    }
  }
  const caretX = center - left;
  const leader: "left" | "right" | null = caretX < CARET_INSET ? "left" : caretX > cardW - CARET_INSET ? "right" : null;
  return {
    left,
    top,
    caretX,
    leader,
    maxHeight: height < cardH ? Math.max(0, Math.floor(height)) : null,
  };
}

export type StageSize = { width: number; height: number; gutter: number };

/**
 * Canvas size from the stage's own box. The border box comes from the flex layout, never
 * from the canvas inside it, and the vertical gutter is always reserved, so no scrollbar
 * that the canvas causes can change the next measurement. Fractional boxes floor so the
 * canvas never overflows by a sub-pixel. The same input returns the same object, so
 * React keeps its state and the observer loop ends.
 */
export function nextStageSize(
  previous: StageSize,
  box: { width: number; height: number; gutter: number },
  floor: { width: number; height: number },
): StageSize {
  const gutter = Math.max(0, Math.round(box.gutter));
  const width = Math.max(floor.width, Math.floor(box.width - gutter));
  const height = Math.max(floor.height, Math.floor(box.height));
  if (width === previous.width && height === previous.height && gutter === previous.gutter) return previous;
  return { width, height, gutter };
}

/** Canvas height that fills the stage without a vertical scrollbar, leaving room for a horizontal one. */
export function stageFillHeight(stage: StageSize, canvasWidth: number): number {
  return canvasWidth > stage.width ? stage.height - stage.gutter : stage.height;
}

/** JetBrains Mono 700 at 9px. */
const EVIDENCE_ID_ADVANCE = 5.4;
/** 6px side padding and a 1px border on each side. */
const EVIDENCE_CHROME = 14;
const EVIDENCE_SLACK = 2;

/** Width that shows the id, title, and meta each on one line without clipping. */
export function evidenceTextWidth(item: { id: string; displayId?: string; title: string; subtitle: string }): number {
  const text = Math.max(
    (item.displayId ?? item.id).length * EVIDENCE_ID_ADVANCE,
    cardTextWidth(evidenceDisplayTitle(item.title), TITLE_GLYPHS),
    cardTextWidth(item.subtitle, META_GLYPHS),
  );
  return Math.ceil(text) + EVIDENCE_CHROME + EVIDENCE_SLACK;
}

/**
 * Left edges for boxes that keep their order and widths on one row.
 * Minimizes the weighted squared distance to each target left edge (pool adjacent
 * violators), so a crowded run spills into free space on both sides and heavier boxes
 * move less. The caller keeps the row wide enough; nothing narrows, wraps, or stacks.
 */
export function packRow(
  items: Array<{ w: number; target: number; weight?: number }>,
  bounds: { left: number; right: number },
  gap: number,
): number[] {
  const count = items.length;
  if (count === 0) return [];
  const offsets: number[] = [];
  let run = 0;
  for (const item of items) {
    offsets.push(run);
    run += item.w + gap;
  }
  const span = run - gap;
  const low = bounds.left;
  const high = Math.max(low, bounds.right - span);
  const blocks: Array<{ sum: number; weight: number; size: number }> = [];
  for (let index = 0; index < count; index += 1) {
    const weight = items[index].weight ?? 1;
    blocks.push({ sum: (items[index].target - offsets[index]) * weight, weight, size: 1 });
    while (blocks.length > 1) {
      const last = blocks[blocks.length - 1];
      const prev = blocks[blocks.length - 2];
      if (prev.sum / prev.weight <= last.sum / last.weight) break;
      prev.sum += last.sum;
      prev.weight += last.weight;
      prev.size += last.size;
      blocks.pop();
    }
  }
  const lefts: number[] = [];
  let index = 0;
  for (const block of blocks) {
    const value = Math.min(high, Math.max(low, block.sum / block.weight));
    for (let k = 0; k < block.size; k += 1) {
      lefts.push(Math.round((value + offsets[index]) * 100) / 100);
      index += 1;
    }
  }
  return lefts;
}

type Chip = { id: string; w: number; ideal: number; x: number; y: number; displaced: boolean };

/** One row. Collisions are shared by both neighbors. Nothing drops to a second row. */
export function placeOneRow(
  items: Array<{ id: string; w: number; ideal: number }>,
  bounds: { left: number; right: number },
  rowY: number,
  gap: number,
): Chip[] {
  const sorted = [...items].sort((a, b) => a.ideal - b.ideal || a.id.localeCompare(b.id));
  const count = sorted.length;
  if (count === 0) return [];
  const half = sorted.map((item) => item.w / 2);
  const sep = (index: number) => half[index] + gap + half[index + 1];
  const centers = sorted.map((item) => item.ideal);
  const leftCenter = bounds.left + half[0];
  const rightCenter = bounds.right - half[count - 1];
  for (let pass = 0; pass < 48; pass += 1) {
    if (centers[0] < leftCenter) {
      const shift = leftCenter - centers[0];
      for (let index = 0; index < count; index += 1) centers[index] += shift;
    }
    if (centers[count - 1] > rightCenter) {
      const shift = centers[count - 1] - rightCenter;
      for (let index = 0; index < count; index += 1) centers[index] -= shift;
    }
    centers[0] = Math.max(leftCenter, centers[0]);
    centers[count - 1] = Math.min(rightCenter, centers[count - 1]);
    for (let index = 0; index < count - 1; index += 1) {
      const overlap = centers[index] + sep(index) - centers[index + 1];
      if (overlap > 0) {
        centers[index] -= overlap / 2;
        centers[index + 1] += overlap / 2;
      }
    }
  }
  return sorted.map((item, index) => ({
    id: item.id,
    w: item.w,
    ideal: item.ideal,
    x: centers[index] - item.w / 2,
    y: rowY,
    displaced: Math.abs(centers[index] - item.ideal) > 24,
  }));
}

/**
 * Equal-height cards on one column, each starting at the mean of its rows.
 * A card that covers more rows keeps that mean. The lighter card moves clear.
 */
/** Cards start below the evidence-column kicker. */
export const EVIDENCE_COLUMN_HEADER = 24;

export function placeCardColumn(
  items: Array<{ id: string; ideal: number; weight?: number }>,
  cardH: number,
  gap: number,
  bounds: { top: number; bottom: number },
): Array<{ id: string; top: number }> {
  const sorted = [...items].sort((a, b) => a.ideal - b.ideal || (b.weight ?? 0) - (a.weight ?? 0) || a.id.localeCompare(b.id));
  const placed: Array<{ id: string; top: number }> = [];
  const separation = cardH + gap;
  const floor = bounds.top;
  const ceil = Math.max(floor, bounds.bottom - cardH);
  for (const item of sorted) {
    let top = Math.min(ceil, Math.max(floor, item.ideal));
    for (let guard = 0; guard < sorted.length + 2; guard += 1) {
      const hit = placed.find((other) => top < other.top + separation && top + separation > other.top);
      if (!hit) break;
      const below = hit.top + separation;
      const above = hit.top - separation;
      if (below <= ceil) top = below;
      else if (above >= floor) top = above;
      else break;
    }
    placed.push({ id: item.id, top });
  }
  return placed;
}

/** Place chips on one row when they fit. Overflow goes to the second row. */
export function placeRow(
  items: Array<{ id: string; w: number; ideal: number }>,
  bounds: { left: number; right: number },
  rowY: number,
  row2Y: number,
  gap: number,
  maxShift: number,
): Chip[] {
  const sorted = [...items].sort((a, b) => a.ideal - b.ideal || a.id.localeCompare(b.id));
  const width = sorted.reduce((sum, item) => sum + item.w, 0) + gap * Math.max(0, sorted.length - 1);
  const room = bounds.right - bounds.left;
  const fitsOneRow = width <= room + 0.5;
  const placed: Chip[] = [];
  let cursor = bounds.left;
  const deferred: typeof sorted = [];
  for (const item of sorted) {
    let x = item.ideal - item.w / 2;
    if (x < cursor) x = cursor;
    const rightLimit = bounds.right - item.w;
    if (x > rightLimit) x = Math.max(bounds.left, rightLimit);
    const shift = Math.abs(x + item.w / 2 - item.ideal);
    const collides = x < cursor - 0.5;
    if (!fitsOneRow && (shift > maxShift || collides || cursor + item.w > bounds.right + 0.5)) {
      deferred.push(item);
      continue;
    }
    if (fitsOneRow && cursor + item.w > bounds.right + 0.5) {
      deferred.push(item);
      continue;
    }
    placed.push({
      id: item.id,
      w: item.w,
      ideal: item.ideal,
      x,
      y: rowY,
      displaced: shift > maxShift,
    });
    cursor = x + item.w + gap;
  }
  let cursor2 = bounds.left;
  for (const item of deferred) {
    let x = item.ideal - item.w / 2;
    if (x < cursor2) x = cursor2;
    const rightLimit = bounds.right - item.w;
    if (x > rightLimit) x = Math.max(bounds.left, rightLimit);
    placed.push({
      id: item.id,
      w: item.w,
      ideal: item.ideal,
      x,
      y: row2Y,
      displaced: true,
    });
    cursor2 = x + item.w + gap;
  }
  return placed;
}

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Card space grows with the actual statement-dot rows; no evidence-coverage inference. */
export function controlBlockHeight(itemCount: number, width: number, minimum = 70): number {
  const columns = Math.max(1, Math.floor((width - 12) / 7));
  const rows = Math.max(1, Math.ceil(itemCount / columns));
  return Math.max(76, minimum + rows * 7);
}
