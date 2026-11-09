import assert from "node:assert/strict";
import test from "node:test";
import { selectedTree, takeRoutes, takenTracks, treePath, type TreeControl, type TreeLane } from "../lib/aegis/selected-tree";

type Point = { x: number; y: number };
type Box = { x: number; y: number; w: number; h: number };

const lanes: TreeLane[] = [
  { id: "AC", x: 16, y: 80, w: 220, h: 160 },
  { id: "AU", x: 248, y: 80, w: 180, h: 160 },
  { id: "CM", x: 440, y: 80, w: 300, h: 160 },
  { id: "IA", x: 16, y: 300, w: 220, h: 160 },
  { id: "SI", x: 440, y: 300, w: 300, h: 160 },
];
const card = (id: string, family: string, x: number, y: number): TreeControl => ({ id, family, x, y, w: 70, h: 76 });
const controls: TreeControl[] = [
  card("AC-2", "AC", 30, 130), card("AC-3", "AC", 120, 130),
  card("AU-2", "AU", 260, 130), card("AU-3", "AU", 340, 130),
  card("CM-2", "CM", 460, 130), card("CM-6", "CM", 560, 130), card("CM-7", "CM", 650, 130),
  card("IA-5", "IA", 30, 350),
  card("SI-2", "SI", 460, 350), card("SI-4", "SI", 560, 350),
];
const byId = (id: string) => controls.find((control) => control.id === id)!;
const selected = byId("CM-6");
const targets = ["AC-3", "AU-2", "CM-2", "CM-7", "IA-5", "SI-2", "SI-4"].map(byId);
const routes = selectedTree({ selected, targets, lanes, controls, obstacles: [], width: 760, height: 480 });

const inside = (a: Point, b: Point, box: Box) =>
  Math.max(a.x, b.x) > box.x && Math.min(a.x, b.x) < box.x + box.w && Math.max(a.y, b.y) > box.y && Math.min(a.y, b.y) < box.y + box.h;
const segments = (points: Point[]) => points.slice(1).map((point, index) => [points[index], point] as const);

test("every related control gets a route from the selected control", () => {
  assert.deepEqual([...routes.keys()].sort(), targets.map((target) => target.id).sort());
  for (const [id, points] of routes) {
    const target = byId(id);
    const first = points[0], last = points.at(-1)!;
    assert.equal(first.x, selected.x + selected.w / 2, `${id} leaves from the selected card's centre`);
    assert.ok(first.y === selected.y || first.y === selected.y + selected.h, `${id} leaves from the selected card's edge`);
    assert.equal(last.x, target.x + target.w / 2, `${id} lands on the target's centre`);
    assert.ok(last.y === target.y || last.y === target.y + target.h, `${id} lands on the target's edge`);
  }
});

test("routes are straight runs that meet at right angles", () => {
  for (const [id, points] of routes) {
    for (const [a, b] of segments(points)) assert.ok(a.x === b.x || a.y === b.y, `${id} has a diagonal run`);
    segments(points).slice(1).forEach(([a, b], index) => {
      const [c, d] = segments(points)[index];
      assert.notEqual(c.x === d.x, a.x === b.x, `${id} has two runs in the same direction`);
    });
  }
});

test("routes share one trunk out of the selected control", () => {
  const all = [...routes.values()];
  const trunk = all[0].slice(0, 2);
  for (const points of all) assert.deepEqual(points.slice(0, 2).map((point) => point.x), trunk.map((point) => point.x));
  const exits = new Set(all.map((points) => `${points[0].x},${points[0].y}`));
  assert.equal(exits.size, 1);
});

test("routes never cross unrelated control boxes or foreign family frames", () => {
  for (const [id, points] of routes) {
    const target = byId(id);
    const foreign = lanes.filter((lane) => lane.id !== selected.family && lane.id !== target.family);
    const others = controls.filter((control) => control.id !== id && control.id !== selected.id);
    for (const [a, b] of segments(points)) {
      for (const lane of foreign) assert.equal(inside(a, b, lane), false, `${id} crosses frame ${lane.id}`);
      for (const box of others) assert.equal(inside(a, b, box), false, `${id} crosses ${box.id}`);
    }
  }
});

test("same-row targets in other families hang off one gutter bus", () => {
  const busYs = new Set(["AC-3", "AU-2"].map((id) => routes.get(id)!.at(-2)!.y));
  assert.equal(busYs.size, 1);
  const [busY] = busYs;
  assert.ok(busY > 240 && busY < 300, "bus runs in the gutter between frame rows");
});

test("tree paths are written as straight cubic segments", () => {
  const path = treePath(routes.get("IA-5")!);
  assert.match(path, /^M /);
  assert.doesNotMatch(path, /[LHVQA]/);
  const values = [...path.matchAll(/C ([\d. -]+)/g)].map((match) => match[1].trim().split(" ").map(Number));
  for (const [ax, ay, bx, by, ex, ey] of values) {
    assert.ok((ax === bx && bx === ex) || (ay === by && by === ey), "control points lie on the run");
  }
  assert.equal(treePath([{ x: 1, y: 1 }]), "");
});

const chip = (id: string, x: number) => ({ id, family: "", x, y: 0, w: 100, h: 40 });
const roleA = chip("role-a", 300);
const roleB = chip("role-b", 520);
const roleInput = (selected: TreeControl, ids: string[], taken: ReturnType<typeof takenTracks>) => selectedTree({
  selected,
  targets: ids.map(byId),
  lanes,
  controls,
  obstacles: [roleA, roleB].filter((box) => box !== selected),
  width: 760,
  height: 480,
  taken,
});

test("attachment trees reach controls in other families without crossing boxes", () => {
  const taken = takenTracks();
  const tree = roleInput(roleA, ["AC-3", "CM-6", "SI-2"], taken);
  assert.deepEqual([...tree.keys()].sort(), ["AC-3", "CM-6", "SI-2"]);
  for (const [id, points] of tree) {
    assert.deepEqual(points[0], { x: 350, y: 40 }, `${id} leaves the chip's bottom centre`);
    const target = byId(id);
    for (const [a, b] of segments(points)) {
      assert.ok(a.x === b.x || a.y === b.y, `${id} has a diagonal run`);
      for (const lane of lanes.filter((lane) => lane.id !== target.family)) assert.equal(inside(a, b, lane), false, `${id} crosses frame ${lane.id}`);
      for (const box of controls.filter((control) => control.id !== id)) assert.equal(inside(a, b, box), false, `${id} crosses ${box.id}`);
    }
  }
});

test("a later attachment tree keeps off the tracks an earlier tree took", () => {
  const taken = takenTracks();
  const first = roleInput(roleA, ["AC-3", "CM-7"], taken);
  takeRoutes(taken, first.values());
  const second = roleInput(roleB, ["AC-2", "CM-2"], taken);
  const runs = (tree: Map<string, Point[]>) => [...tree.values()].flatMap((points) => segments(points).filter(([a, b]) => a.y === b.y && a.x !== b.x).map(([a, b]) => ({ y: a.y, low: Math.min(a.x, b.x), high: Math.max(a.x, b.x) })));
  for (const run of runs(second)) {
    for (const other of runs(first)) {
      const overlap = Math.min(run.high, other.high) - Math.max(run.low, other.low);
      assert.ok(run.y !== other.y || overlap <= 0, `second tree reuses y=${run.y} from ${Math.max(run.low, other.low)} to ${Math.min(run.high, other.high)}`);
    }
  }
});
