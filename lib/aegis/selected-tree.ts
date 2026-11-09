/** Links from the selected control drawn as one tree. A single trunk leaves the
 * selected control and every related control branches off it at a right angle.
 * Horizontal and vertical runs stay in the gutters between family frames; only
 * the selected family and each related control's own frame are entered. */

type Box = { x: number; y: number; w: number; h: number };
type Point = { x: number; y: number };
export type TreeLane = Box & { id: string };
/** port: x where the line meets the box, when it is not the box centre. */
export type TreeControl = Box & { id: string; family: string; port?: number };
export type TreeInput = {
  selected: TreeControl;
  targets: TreeControl[];
  lanes: TreeLane[];
  controls: TreeControl[];
  /** Role, evidence and pill cards. Lines keep clear of them. */
  obstacles: Box[];
  width: number;
  height: number;
  /** Runs of trees routed earlier. Given this, the tree gets parallel tracks in each gutter and pays to reuse a taken one. */
  taken?: TakenTracks;
  /** Planning map: the header strip of every frame (above its first card row) is never crossed,
   * so lines leave and enter cards from the gutter side instead of running through a family title. */
  avoidHeaders?: boolean;
  /** Clearance kept around obstacle cards; a tighter retry uses less before giving up on the grid. */
  cardPad?: number;
  /** Planning map: an unreachable target gets a tighter retry, then a stem that keeps clear of obstacle cards. */
  clearStems?: boolean;
};

type Interval = [number, number];
/** Horizontal runs keyed by y and vertical runs keyed by x. */
export type TakenTracks = { rows: Map<number, Interval[]>; columns: Map<number, Interval[]> };

const CARD_PAD = 4;
const CONTROL_PAD = 3;
/** Distance of a gutter track from the frame row it serves. */
const GUTTER_INSET = 14;
const BEND = 40;
/** Runs closer than this to a padded box squeeze between cards and cost more. */
const NARROW = 4;
const NARROW_WEIGHT = 4;
/** Buses run along the gutters; a branch climbing back between frame rows costs more than extending a bus. */
const VERTICAL_WEIGHT = 2;
/** Spacing of parallel tracks, so two 2px lines keep a clear gap between them. */
const TRACK_GAP = 6;
const SHARED_WEIGHT = 8;
/** Stepping across to a neighbouring parallel track. */
const JOG = BEND * 3;
/** Rows above and below an attachment tree's boxes that its first routing attempt may use. */
const WINDOW = 120;

/** short: a link between neighbouring parallel tracks. */
type Edge = { to: number; cost: number; dir: 0 | 1; via?: Point[]; short?: boolean };

const n = (value: number) => Math.round(value * 100) / 100;
const grow = (box: Box, pad: number): Box => ({ x: box.x - pad, y: box.y - pad, w: box.w + pad * 2, h: box.h + pad * 2 });

function crosses(a: Point, b: Point, box: Box): boolean {
  const left = Math.min(a.x, b.x), right = Math.max(a.x, b.x), top = Math.min(a.y, b.y), bottom = Math.max(a.y, b.y);
  return right > box.x && left < box.x + box.w && bottom > box.y && top < box.y + box.h;
}

function clearRun(points: Point[], boxes: Box[]): boolean {
  return points.slice(1).every((point, index) => !boxes.some((box) => crosses(points[index], point, box)));
}

function merged(spans: Interval[]): Interval[] {
  const out: Interval[] = [];
  for (const span of spans.sort((a, b) => a[0] - b[0])) {
    const last = out.at(-1);
    if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
    else out.push([span[0], span[1]]);
  }
  return out;
}

function uniq(values: number[], low: number, high: number, gap = 1): number[] {
  const out: number[] = [];
  for (const value of values.map(n).filter((value) => value >= low && value <= high).sort((a, b) => a - b)) {
    if (out.length === 0 || value - out[out.length - 1] > gap) out.push(value);
  }
  return out;
}

/** Up to three tracks around the middle of a gap, at least edge away from both sides. A gap too narrow for two gets its middle. */
function tracks(low: number, high: number, edge: number): number[] {
  const count = Math.min(3, Math.max(1, Math.floor((high - low - edge * 2) / TRACK_GAP) + 1));
  const first = (low + high) / 2 - ((count - 1) * TRACK_GAP) / 2;
  return Array.from({ length: count }, (_, index) => first + index * TRACK_GAP);
}

/** Horizontal gutters: free bands between frame rows, card rows and the canvas edges. */
function gutterYs(rows: Box[], height: number, spread: boolean): number[] {
  const out: number[] = [];
  const add = (low: number, high: number) => {
    const gap = high - low;
    if (gap < 8) return;
    if (gap >= GUTTER_INSET * 2 + 12) {
      out.push(low + GUTTER_INSET, high - GUTTER_INSET);
      if (spread) out.push(...[1, 2].flatMap((step) => [low + GUTTER_INSET - step * TRACK_GAP, low + GUTTER_INSET + step * TRACK_GAP, high - GUTTER_INSET - step * TRACK_GAP, high - GUTTER_INSET + step * TRACK_GAP]).filter((y) => y >= low + 4 && y <= high - 4));
    } else out.push(...(spread ? tracks(low, high, NARROW) : [(low + high) / 2]));
  };
  let cursor = 0;
  for (const [top, bottom] of merged(rows.map((row) => [row.y, row.y + row.h]))) {
    if (top > cursor) add(cursor, top);
    cursor = Math.max(cursor, bottom);
  }
  add(cursor, height);
  return out;
}

/** Vertical gaps between boxes that share a row, plus one outside each end. */
function rowGapXs(boxes: Box[], width: number, spread = false): number[] {
  const gap = (low: number, high: number) => (spread ? tracks(low, high, 3) : [(low + high) / 2]);
  const rows = new Map<number, Box[]>();
  for (const box of boxes) {
    const key = Math.round(box.y);
    rows.set(key, [...(rows.get(key) ?? []), box]);
  }
  const out: number[] = [];
  for (const row of rows.values()) {
    const sorted = [...row].sort((a, b) => a.x - b.x);
    out.push(...gap(0, sorted[0].x), ...gap(sorted.at(-1)!.x + sorted.at(-1)!.w, width));
    sorted.slice(1).forEach((box, index) => {
      const before = sorted[index];
      if (box.x - (before.x + before.w) >= 6) out.push(...gap(before.x + before.w, box.x));
    });
  }
  return out;
}

/** Control rows inside one frame: the strip under the header, the gaps between rows and the strip above the frame bottom. */
function laneRows(lane: Box, members: Box[]): { top: number; bottom: number; above: number; below: number }[] {
  const tops = [...new Set(members.map((member) => Math.round(member.y)))].sort((a, b) => a - b);
  const rows = tops.map((top) => {
    const row = members.filter((member) => Math.round(member.y) === top);
    return { top: Math.min(...row.map((member) => member.y)), bottom: Math.max(...row.map((member) => member.y + member.h)) };
  });
  return rows.map((row, index) => ({
    ...row,
    above: index === 0 ? row.top - 6 : (rows[index - 1].bottom + row.top) / 2,
    below: index === rows.length - 1 ? (row.bottom + lane.y + lane.h) / 2 : (row.bottom + rows[index + 1].top) / 2,
  }));
}

class Heap {
  private keys: number[] = [];
  private items: number[] = [];
  get size() { return this.items.length; }
  push(item: number, key: number) {
    let index = this.items.length;
    this.items.push(item);
    this.keys.push(key);
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (this.keys[parent] <= key) break;
      this.items[index] = this.items[parent];
      this.keys[index] = this.keys[parent];
      index = parent;
    }
    this.items[index] = item;
    this.keys[index] = key;
  }
  pop(): [number, number] {
    const top: [number, number] = [this.items[0], this.keys[0]];
    const item = this.items.pop()!;
    const key = this.keys.pop()!;
    if (this.items.length) {
      let index = 0;
      for (;;) {
        const left = index * 2 + 1;
        if (left >= this.items.length) break;
        const child = left + 1 < this.items.length && this.keys[left + 1] < this.keys[left] ? left + 1 : left;
        if (this.keys[child] >= key) break;
        this.items[index] = this.items[child];
        this.keys[index] = this.keys[child];
        index = child;
      }
      this.items[index] = item;
      this.keys[index] = key;
    }
    return top;
  }
}

/** Routes keyed by target id. Each route runs from the selected control to the target and repeats the shared trunk exactly.
 * Every target gets a route: one the grid cannot reach gets a direct stem from the selected box. */
export function selectedTree(input: TreeInput): Map<string, Point[]> {
  const routes = gridTree(input);
  // A target boxed in by its own headers or tiles may still be reached through its frame's header strip.
  if (input.avoidHeaders && routes.size < input.targets.length) {
    const missing = input.targets.filter((target) => !routes.has(target.id));
    for (const [id, route] of gridTree({ ...input, targets: missing, avoidHeaders: false })) routes.set(id, route);
  }
  // Before a straight stem (which ignores obstacles) try once more with less clearance around evidence and role cards.
  if (input.clearStems && routes.size < input.targets.length) {
    const missing = input.targets.filter((target) => !routes.has(target.id));
    for (const [id, route] of gridTree({ ...input, targets: missing, avoidHeaders: false, cardPad: 1 })) routes.set(id, route);
  }
  for (const target of input.targets) {
    if (!routes.has(target.id)) routes.set(target.id, (input.clearStems ? clearStem(input, target) : null) ?? stemRoute(input.selected, target, input.selected.port, target.port));
  }
  return routes;
}

function gridTree(input: TreeInput): Map<string, Point[]> {
  if (!input.taken || input.targets.length === 0) return routeTree(input);
  // Attachment trees first route within the rows around their source and targets; the full map is the fallback.
  const boxes = [input.selected, ...input.targets];
  const window: Interval = [Math.min(...boxes.map((box) => box.y)) - WINDOW, Math.max(...boxes.map((box) => box.y + box.h)) + WINDOW];
  const near = routeTree(input, window);
  return near.size === input.targets.length ? near : routeTree(input);
}

/** Last resort for a target the grid cannot reach: a stem with one or two bends whose runs keep clear of every
 * obstacle card (evidence, role, pill) and, when possible, of other control cards. Item g:
 * a line never passes behind an evidence box. Null when no such stem exists. */
export function clearStem(input: TreeInput, target: TreeControl): Point[] | null {
  const { selected, lanes, obstacles, controls, width, height } = input;
  const cards = obstacles.map((box) => grow(box, 2));
  const others = controls.filter((control) => control.id !== selected.id && control.id !== target.id).map((control) => grow(control, 1));
  const ys = uniq([...gutterYs([...lanes, ...obstacles], height, false), ...gutterYs([...obstacles, ...controls], height, false)], 1, height - 1);
  const xs = uniq([...rowGapXs(lanes, width), ...rowGapXs(obstacles, width), ...rowGapXs(controls, width)], 1, width - 1);
  const sx = n(selected.port ?? selected.x + selected.w / 2), tx = n(target.port ?? target.x + target.w / 2);
  const ends = (box: Box, x: number) => [{ x, y: n(box.y), up: true }, { x, y: n(box.y + box.h), up: false }];
  const length = (route: Point[]) => route.slice(1).reduce((sum, point, index) => sum + Math.abs(point.x - route[index].x) + Math.abs(point.y - route[index].y), 0);
  const leaves = (end: { y: number; up: boolean }, y: number) => (end.up ? y < end.y - 4 : y > end.y + 4);
  for (const blocked of [[...cards, ...others], cards]) {
    let best: Point[] | null = null;
    const offer = (route: Point[]) => { if (clearRun(route, blocked) && (!best || length(route) < length(best))) best = simplify(route); };
    for (const a of ends(selected, sx)) for (const b of ends(target, tx)) for (const y of ys) {
      if (leaves(a, y) && leaves(b, y)) offer([{ x: a.x, y: a.y }, { x: sx, y }, { x: tx, y }, { x: b.x, y: b.y }]);
    }
    if (!best) {
      for (const a of ends(selected, sx)) for (const b of ends(target, tx)) for (const y1 of ys) {
        if (!leaves(a, y1) || !clearRun([{ x: a.x, y: a.y }, { x: sx, y: y1 }], blocked)) continue;
        for (const y2 of ys) {
          if (!leaves(b, y2) || !clearRun([{ x: tx, y: y2 }, { x: b.x, y: b.y }], blocked)) continue;
          for (const x of xs) offer([{ x: a.x, y: a.y }, { x: sx, y: y1 }, { x, y: y1 }, { x, y: y2 }, { x: tx, y: y2 }, { x: b.x, y: b.y }]);
        }
      }
    }
    if (best) return best;
  }
  return null;
}

/** A one-branch tree between two boxes, such as a missing pill and its control. It leaves the
 * facing side of `from`, runs straight when the boxes overlap in x and jogs once halfway when
 * they do not. Boxes side by side are joined over the top of both. */
export function stemRoute(from: Box, to: Box, fromX = from.x + from.w / 2, toX = to.x + to.w / 2): Point[] {
  const x2 = fromX > to.x + 2 && fromX < to.x + to.w - 2 ? fromX : toX;
  if (to.y >= from.y + from.h) return orthogonal([{ x: fromX, y: from.y + from.h }, { x: x2, y: to.y }]);
  if (from.y >= to.y + to.h) return orthogonal([{ x: fromX, y: from.y }, { x: x2, y: to.y + to.h }]);
  const over = Math.min(from.y, to.y) - 12;
  return simplify([{ x: fromX, y: from.y }, { x: fromX, y: over }, { x: toX, y: over }, { x: toX, y: to.y }].map(round));
}

/** A branch from `from` to `to` that leaves and arrives horizontally, with its vertical run on the trunk at `trunkX`.
 * Branches of one source that share `trunkX` share their trunk. */
export function busRoute(from: Point, to: Point, trunkX: number): Point[] {
  return simplify([from, { x: trunkX, y: from.y }, { x: trunkX, y: to.y }, to].map(round));
}

/** Vertical, then horizontal halfway, then vertical. */
function orthogonal([a, b]: [Point, Point]): Point[] {
  const middle = (a.y + b.y) / 2;
  return simplify([a, { x: a.x, y: middle }, { x: b.x, y: middle }, b].map(round));
}

const round = (point: Point): Point => ({ x: n(point.x), y: n(point.y) });

function routeTree(input: TreeInput, window?: Interval): Map<string, Point[]> {
  const { selected, targets, lanes, controls, obstacles, width, height, taken } = input;
  const inWindow = (box: Box) => !window || (box.y + box.h >= window[0] && box.y <= window[1]);
  const spread = Boolean(taken);
  const home = lanes.find((lane) => lane.id === selected.family);
  const membersOf = (lane: TreeLane) => controls.filter((control) => control.family === lane.id);
  const homeMembers = home ? membersOf(home) : [selected];
  const cards = obstacles.map((box) => grow(box, input.cardPad ?? CARD_PAD));
  const grown = new Map(homeMembers.map((control) => [control.id, grow(control, CONTROL_PAD)]));
  const headers = input.avoidHeaders ? lanes.flatMap((lane) => {
    const members = membersOf(lane);
    if (!members.length) return [];
    const top = Math.min(...members.map((control) => control.y));
    return top - lane.y > 8 ? [{ x: lane.x, y: lane.y, w: lane.w, h: top - lane.y - 2 }] : [];
  }) : [];
  const blocked = [...lanes.filter((lane) => lane !== home), ...grown.values(), ...cards, ...headers];

  const center = (box: TreeControl) => box.port ?? box.x + box.w / 2;
  const targetLanes = [...new Set(targets.map((target) => lanes.find((lane) => lane.id === target.family)).filter((lane): lane is TreeLane => Boolean(lane)))];
  const homeRows = home ? laneRows(home, homeMembers) : [];
  const ys = uniq([
    ...gutterYs([...lanes, ...obstacles], height, false),
    ...(spread ? gutterYs([...lanes, ...cards], height, true) : []),
    ...homeRows.flatMap((row) => [row.above, row.below]),
  ], Math.max(1, window?.[0] ?? 1), Math.min(height - 1, window?.[1] ?? height), spread ? TRACK_GAP - 1 : 1);
  const homeColumns = home ? rowGapXs(homeMembers, width).filter((x) => x > home.x && x < home.x + home.w) : [];
  const xs = uniq([
    ...rowGapXs(lanes.filter(inWindow), width, spread),
    ...rowGapXs(obstacles.filter(inWindow), width, spread),
    center(selected),
    ...targets.map(center),
    ...homeColumns,
    ...(home ? [home.x + 6, home.x + home.w - 6] : []),
    ...targetLanes.flatMap((lane) => [lane.x + 6, lane.x + lane.w - 6]),
  ], 1, width - 1);

  const rowBlocks = ys.map((y) => merged(blocked.filter((box) => y > box.y && y < box.y + box.h).map((box) => [box.x, box.x + box.w])));
  const columnBlocks = xs.map((x) => merged(blocked.filter((box) => x > box.x && x < box.x + box.w).map((box) => [box.y, box.y + box.h])));
  const freeAt = (spans: Interval[], value: number) => !spans.some(([low, high]) => value > low && value < high);
  const freeRun = (spans: Interval[], a: number, b: number) => !spans.some(([low, high]) => low < Math.max(a, b) && high > Math.min(a, b));

  const ids = new Int32Array(xs.length * ys.length).fill(-1);
  const points: Point[] = [];
  ys.forEach((y, row) => xs.forEach((x, column) => {
    if (freeAt(rowBlocks[row], x)) {
      ids[row * xs.length + column] = points.length;
      points.push({ x, y });
    }
  }));
  const S = points.length;
  const T0 = S + 1;
  const total = T0 + targets.length;
  const edges: Edge[][] = Array.from({ length: total }, () => []);
  const beside = (at: number, low: (box: Box) => number, size: (box: Box) => number, from: (box: Box) => number, span: (box: Box) => number) => merged(blocked
    .filter((box) => (at > low(box) - NARROW && at <= low(box)) || (at >= low(box) + size(box) && at < low(box) + size(box) + NARROW))
    .map((box) => [from(box), from(box) + span(box)]));
  const rowNear = ys.map((y) => beside(y, (box) => box.y, (box) => box.h, (box) => box.x, (box) => box.w));
  const columnNear = xs.map((x) => beside(x, (box) => box.x, (box) => box.w, (box) => box.y, (box) => box.h));
  const link = (a: number, b: number, dir: 0 | 1, near: Interval[]) => {
    const along = dir === 0 ? [points[a].x, points[b].x] : [points[a].y, points[b].y];
    const used = dir === 0 ? taken?.rows.get(points[a].y) : taken?.columns.get(points[a].x);
    const shared = used ? !freeRun(used, along[0], along[1]) : false;
    const length = Math.abs(along[1] - along[0]);
    const short = spread && length <= TRACK_GAP + 0.5;
    const cost = length * (dir === 1 ? VERTICAL_WEIGHT : 1) * (freeRun(near, along[0], along[1]) ? 1 : NARROW_WEIGHT) * (shared ? SHARED_WEIGHT : 1);
    edges[a].push({ to: b, cost, dir, short });
    edges[b].push({ to: a, cost, dir, short });
  };
  ys.forEach((y, row) => {
    let last = -1;
    xs.forEach((x, column) => {
      const id = ids[row * xs.length + column];
      if (id < 0) return;
      if (last >= 0 && freeRun(rowBlocks[row], points[last].x, x)) link(last, id, 0, rowNear[row]);
      last = id;
    });
  });
  xs.forEach((x, column) => {
    let last = -1;
    ys.forEach((y, row) => {
      const id = ids[row * xs.length + column];
      if (id < 0) return;
      if (last >= 0 && freeRun(columnBlocks[column], points[last].y, y)) link(last, id, 1, columnNear[column]);
      last = id;
    });
  });

  /** Grid column at most a pixel from x. Ports snap to it so the first run stays vertical. */
  const snap = (x: number) => {
    let column = -1;
    xs.forEach((value, index) => { if (Math.abs(value - x) <= 1 && (column < 0 || Math.abs(value - x) < Math.abs(xs[column] - x))) column = index; });
    return column < 0 ? n(x) : xs[column];
  };
  /** First grid node straight up or down from a point, reached without crossing the given boxes. */
  const nodeFrom = (from: Point, step: -1 | 1, boxes: Box[]): number => {
    const column = xs.indexOf(from.x);
    if (column < 0) return -1;
    const order = step < 0 ? [...ys.keys()].reverse() : [...ys.keys()];
    for (const row of order) {
      if ((ys[row] - from.y) * step <= 0) continue;
      const id = ids[row * xs.length + column];
      if (id < 0) continue;
      return clearRun([from, points[id]], boxes) ? id : -1;
    }
    return -1;
  };

  const exits: Edge[] = [];
  const selectedBoxes = blocked.filter((box) => box !== grown.get(selected.id));
  for (const step of [-1, 1] as const) {
    const port = { x: snap(center(selected)), y: step < 0 ? selected.y : selected.y + selected.h };
    const id = nodeFrom(port, step, selectedBoxes);
    if (id >= 0) exits.push({ to: id, cost: Math.abs(points[id].y - port.y), dir: 1, via: [port] });
  }

  targets.forEach((target, index) => {
    const lane = lanes.find((item) => item.id === target.family);
    const local = lane && lane !== home ? membersOf(lane).filter((control) => control.id !== target.id).map((control) => grow(control, CONTROL_PAD)) : [];
    const boxes = [...blocked.filter((box) => box !== grown.get(target.id) && (lane === home || box !== lane)), ...local];
    const node = T0 + index;
    const cx = snap(center(target));
    let straight = false;
    for (const step of [-1, 1] as const) {
      const port = { x: cx, y: step < 0 ? target.y : target.y + target.h };
      const id = nodeFrom(port, step, boxes);
      if (id < 0) continue;
      straight = true;
      edges[id].push({ to: node, cost: Math.abs(points[id].y - port.y), dir: 1, via: [port] });
    }
    if (straight || !lane || lane === home) return;
    const row = laneRows(lane, membersOf(lane)).find((item) => target.y >= item.top - 0.5 && target.y <= item.bottom);
    if (!row) return;
    for (const step of [-1, 1] as const) {
      const port = { x: cx, y: step < 0 ? target.y : target.y + target.h };
      const gapY = n(step < 0 ? row.above : row.below);
      for (const stripX of [snap(lane.x + 6), snap(lane.x + lane.w - 6)]) {
        for (const leave of [-1, 1] as const) {
          const turn = { x: stripX, y: gapY };
          const id = nodeFrom(turn, leave, boxes);
          if (id < 0 || !clearRun([port, { x: cx, y: gapY }, turn], boxes)) continue;
          const length = Math.abs(gapY - port.y) + Math.abs(stripX - cx) + Math.abs(points[id].y - gapY);
          edges[id].push({ to: node, cost: length * NARROW_WEIGHT + BEND * 2, dir: 1, via: [turn, { x: cx, y: gapY }, port] });
        }
      }
    }
  });

  // Targets join frame row by frame row, starting with the selected row, so a
  // row's bus exists before a farther row could pull a branch back across it.
  const bands = [...new Set(lanes.map((lane) => Math.round(lane.y)))].sort((a, b) => a - b);
  const bandOf = (control: TreeControl) => bands.indexOf(Math.round(lanes.find((lane) => lane.id === control.family)?.y ?? NaN));
  const rings: number[][] = [];
  targets.forEach((target, index) => {
    const ring = Math.abs(bandOf(target) - bandOf(selected));
    (rings[ring] ??= []).push(T0 + index);
  });
  const growTree = (exit: Edge) => {
    const states = total * 2;
    const dist = new Float64Array(states).fill(Infinity);
    const prev = new Int32Array(states).fill(-1);
    const prevEdge = new Array<Edge | undefined>(states);
    /** Reached by turning onto links between parallel tracks; turning straight off again is a jog. */
    const stepping = new Uint8Array(states);
    const parent = new Int32Array(total).fill(-1);
    const inEdge = new Array<Edge | undefined>(total);
    const tree = new Uint8Array(total);
    const heap = new Heap();
    const seed = (node: number) => {
      for (const dir of [0, 1]) {
        const state = node * 2 + dir;
        if (dist[state] === 0) continue;
        dist[state] = 0;
        prev[state] = -1;
        stepping[state] = 0;
        heap.push(state, 0);
      }
    };
    const attach = (end: number) => {
      const added: number[] = [];
      for (let state = end; prev[state] >= 0; state = prev[state]) {
        const node = state >> 1;
        parent[node] = prev[state] >> 1;
        inEdge[node] = prevEdge[state];
        tree[node] = 1;
        if (node < S) added.push(node);
      }
      return added;
    };
    const nearest = (nodes: Iterable<number>) => {
      let found = -1;
      for (const node of nodes) for (const state of [node * 2, node * 2 + 1]) if (found < 0 || dist[state] < dist[found]) found = state;
      return found >= 0 && Number.isFinite(dist[found]) ? found : -1;
    };
    tree[S] = 1;
    tree[exit.to] = 1;
    parent[exit.to] = S;
    inEdge[exit.to] = exit;
    seed(exit.to);
    const remaining = new Set(targets.map((_, index) => T0 + index));
    const run = () => {
      while (heap.size) {
        const [state, key] = heap.pop();
        if (key > dist[state]) continue;
        const node = state >> 1, dir = state & 1;
        if (node >= T0) continue;
        for (const edge of edges[node]) {
          if (tree[edge.to]) continue;
          const next = edge.to * 2 + edge.dir;
          const turn = edge.dir !== dir;
          const value = key + edge.cost + (turn ? BEND + (stepping[state] ? JOG : 0) : 0);
          if (value < dist[next]) {
            dist[next] = value;
            stepping[next] = edge.short && (turn || stepping[state]) ? 1 : 0;
            prev[next] = state;
            prevEdge[next] = edge;
            heap.push(next, value);
          }
        }
      }
    };
    run();
    for (const ring of rings) {
      const pending = new Set(ring);
      while (pending.size) {
        const state = nearest(pending);
        if (state < 0) break;
        pending.delete(state >> 1);
        remaining.delete(state >> 1);
        for (const node of attach(state)) seed(node);
        run();
      }
    }
    let cost = 0;
    for (let node = 0; node < total; node += 1) {
      const edge = inEdge[node];
      if (!tree[node] || node === S || !edge) continue;
      const up = inEdge[parent[node]];
      cost += edge.cost + (up && up.dir !== edge.dir ? BEND : 0);
    }
    return { cost, unreached: remaining.size, parent, via: inEdge.map((edge) => edge?.via) };
  };

  // Attachment trees leave on the side facing most of their targets; a selected control tries both.
  const above = targets.filter((target) => target.y + target.h / 2 < selected.y + selected.h / 2).length;
  const facing = taken && exits.length > 1 ? exits.filter((exit) => (points[exit.to].y < selected.y) === (above * 2 > targets.length)) : exits;
  let best: ReturnType<typeof growTree> | null = null;
  for (const exit of facing.length ? facing : exits) {
    const result = growTree(exit);
    if (!best || result.unreached < best.unreached || (result.unreached === best.unreached && result.cost < best.cost)) best = result;
  }
  const routes = new Map<string, Point[]>();
  if (!best) return routes;
  targets.forEach((target, index) => {
    const chain: Point[] = [];
    let node = T0 + index;
    if (best.parent[node] < 0) return;
    while (node !== S && node >= 0) {
      if (node < S) chain.push(points[node]);
      chain.push(...[...(best.via[node] ?? [])].reverse());
      node = best.parent[node];
    }
    routes.set(target.id, simplify(chain.reverse()));
  });
  return routes;
}

function simplify(points: Point[]): Point[] {
  const out: Point[] = [];
  for (const point of points) {
    const last = out.at(-1);
    if (last && last.x === point.x && last.y === point.y) continue;
    const before = out.at(-2);
    if (before && last && ((before.x === last.x && last.x === point.x) || (before.y === last.y && last.y === point.y))) out[out.length - 1] = point;
    else out.push(point);
  }
  return out;
}

/** Straight runs written as cubic segments, which the map's route checks expect. */
export function treePath(points: Point[]): string {
  if (points.length < 2) return "";
  let path = `M ${n(points[0].x)} ${n(points[0].y)}`;
  for (let index = 1; index < points.length; index += 1) {
    const a = points[index - 1], b = points[index];
    const dx = b.x - a.x, dy = b.y - a.y;
    path += ` C ${n(a.x + dx / 3)} ${n(a.y + dy / 3)} ${n(a.x + dx * 2 / 3)} ${n(a.y + dy * 2 / 3)} ${n(b.x)} ${n(b.y)}`;
  }
  return path;
}

export function takenTracks(): TakenTracks {
  return { rows: new Map(), columns: new Map() };
}

/** Records the runs of a routed tree so later trees keep to other tracks. */
export function takeRoutes(taken: TakenTracks, routes: Iterable<Point[]>) {
  for (const points of routes) {
    for (let index = 1; index < points.length; index += 1) {
      const a = points[index - 1], b = points[index];
      const [map, key, span] = a.y === b.y ? [taken.rows, n(a.y), [Math.min(a.x, b.x), Math.max(a.x, b.x)] as Interval]
        : [taken.columns, n(a.x), [Math.min(a.y, b.y), Math.max(a.y, b.y)] as Interval];
      map.set(key, merged([...(map.get(key) ?? []), span]));
    }
  }
}
