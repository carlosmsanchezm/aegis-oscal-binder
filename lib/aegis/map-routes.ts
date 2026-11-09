/** Every line on the package map, routed as trees by `selectedTree`. Routes are point lists;
 * `treePath` writes them. Nothing here draws a curve. */
import { selectedTree, stemRoute, takenTracks, takeRoutes, type TreeControl } from "./selected-tree";
import { spread } from "./map-layout";
import type { buildLayout, LayoutControl } from "./map-placement";

export type MapLayout = ReturnType<typeof buildLayout>;
type Point = { x: number; y: number };
export type Route = Point[];
type Links = { mutual: { otherId: string }[]; outbound: { otherId: string }[]; reverse: { otherId: string }[] };
export type RelatedRoute = { key: string; route: Route; from: string; to: string; glyph: "mutual" | "outbound" | "reverse" };

/** Controls of a role chip, each with the x where its line lands among the roles that share the control. */
function roleTargets(layout: MapLayout, role: MapLayout["roles"][number]): TreeControl[] {
  return role.controlIds.flatMap((id) => {
    const control = layout.controls.find((item) => item.id === id);
    if (!control) return [];
    const fellows = layout.roles.filter((item) => item.controlIds.includes(id));
    return [{ ...control, port: spread(control.x, control.w, fellows.length, Math.max(0, fellows.findIndex((item) => item.id === role.id)), 0.6) }];
  });
}

/** Controls of an evidence card, each with the x where its line leaves among the cards that share the control. */
function evidenceTargets(layout: MapLayout, evidence: MapLayout["evidence"][number]): TreeControl[] {
  return evidence.controlIds.flatMap((id) => {
    const control = layout.controls.find((item) => item.id === id);
    if (!control) return [];
    const fellows = layout.evidence.filter((item) => item.controlIds.includes(id));
    return [{ ...control, port: spread(control.x, control.w, fellows.length, Math.max(0, fellows.findIndex((item) => item.id === evidence.id)), 0.6) }];
  });
}

export const roleTreeKey = (role: { id: string }) => `role:${role.id}`;
/** Packages can reuse an evidence id on several boxes, even in one band; each box has its own tree. */
export const evidenceTreeKey = (evidence: { id: string; uuid: string; band: number }) => `ev:${evidence.id}|${evidence.uuid}:${evidence.band}`;

export type AttachmentRouter = { tree: (key: string) => Map<string, Route> | undefined; next: () => boolean };

/** One tree per role chip and evidence card. Trees are routed in a fixed order, roles first,
 * and each keeps off the tracks of the trees before it, so the result does not depend on
 * which tree is asked for first. Routes run from the source to each control. */
export function attachmentRouter(layout: MapLayout, planning = false): AttachmentRouter {
  const jobs = [
    ...layout.roles.map((role) => ({ key: roleTreeKey(role), source: role, targets: () => roleTargets(layout, role) })),
    ...layout.evidence.map((evidence) => ({ key: evidenceTreeKey(evidence), source: evidence, targets: () => evidenceTargets(layout, evidence) })),
  ];
  const trees = new Map<string, Map<string, Route>>();
  const taken = takenTracks();
  let done = 0;
  const next = () => {
    const job = jobs[done];
    if (!job) return false;
    done += 1;
    const { source } = job;
    const tree = selectedTree({
      selected: { id: source.id, family: "", x: source.x, y: source.y, w: source.w, h: source.h },
      targets: job.targets(),
      lanes: layout.lanes,
      controls: layout.controls,
      obstacles: [...layout.roles, ...layout.evidence, ...layout.pills].filter((box) => box !== source),
      width: layout.width,
      height: layout.height,
      taken,
      clearStems: planning,
    });
    takeRoutes(taken, tree.values());
    trees.set(job.key, tree);
    return done < jobs.length;
  };
  return {
    tree: (key) => {
      while (!trees.has(key) && done < jobs.length) next();
      return trees.get(key);
    },
    next,
  };
}

/** A missing pill's line, from its control to the pill. */
export function pillRoute(layout: MapLayout, pill: MapLayout["pills"][number]): Route | null {
  const control = layout.controls.find((item) => item.id === pill.controlId);
  return control ? stemRoute(control, pill) : null;
}

/** Canvas height the related trees may use: the last family row plus a margin. */
const relatedHeight = (layout: MapLayout) => Math.min(layout.height, (layout.bands.at(-1)?.bottom ?? layout.height) + 24);

function tree(layout: MapLayout, selected: TreeControl, targets: TreeControl[], avoidHeaders = false) {
  return selectedTree({
    avoidHeaders,
    clearStems: avoidHeaders,
    selected,
    targets,
    lanes: layout.lanes,
    controls: layout.controls,
    obstacles: [...layout.roles, ...layout.evidence, ...layout.pills],
    width: layout.width,
    height: relatedHeight(layout),
  });
}

/** Catalog links of one control: one tree from it to every related control.
 * Routes run from the selected control; `directed` turns a reverse link's route to end on the selected control. */
export function relatedRoutes(layout: MapLayout, selectedId: string, links: Links, directed = false, avoidHeaders = false): RelatedRoute[] {
  const byId = new Map(layout.controls.map((control) => [control.id, control]));
  const selected = byId.get(selectedId);
  if (!selected) return [];
  const rows = [
    ...links.mutual.map((link) => ({ otherId: link.otherId, glyph: "mutual" as const, from: selectedId, to: link.otherId })),
    ...links.outbound.map((link) => ({ otherId: link.otherId, glyph: "outbound" as const, from: selectedId, to: link.otherId })),
    ...links.reverse.map((link) => ({ otherId: link.otherId, glyph: "reverse" as const, from: link.otherId, to: selectedId })),
  ].sort((a, b) => (byId.get(a.otherId)?.x ?? 0) - (byId.get(b.otherId)?.x ?? 0));
  const targets = [...new Set(rows.map((row) => byId.get(row.otherId)).filter((control): control is LayoutControl => Boolean(control)))];
  const routes = tree(layout, selected, targets, avoidHeaders);
  return rows.flatMap((row) => {
    const route = routes.get(row.otherId);
    if (!route) return [];
    return [{ key: `rel-${row.from}-${row.to}`, route: directed && row.to === selectedId ? [...route].reverse() : route, from: row.from, to: row.to, glyph: row.glyph }];
  });
}

/** One tree from a family frame to each other family frame it links to, keyed by the other family. */
export function familyRoutes(layout: MapLayout, familyId: string, otherIds: string[]): Map<string, Route> {
  const lane = layout.lanes.find((item) => item.id === familyId);
  if (!lane) return new Map();
  const frame = (item: MapLayout["lanes"][number]): TreeControl => ({ id: item.id, family: item.id, x: item.x, y: item.y, w: item.w, h: item.h });
  const targets = otherIds.flatMap((id) => layout.lanes.filter((item) => item.id === id && item !== lane).map(frame));
  return tree(layout, frame(lane), targets);
}

/** Links between controls of one family: one tree from each control to the later controls it pairs with. Keyed `from|to`. */
export function withinRoutes(layout: MapLayout, familyId: string, paired: (a: string, b: string) => boolean): Map<string, Route> {
  const members = layout.controls.filter((control) => control.family === familyId);
  const out = new Map<string, Route>();
  members.forEach((member, index) => {
    const targets = members.slice(index + 1).filter((other) => paired(member.id, other.id));
    if (!targets.length) return;
    for (const [id, route] of tree(layout, member, targets)) out.set(`${member.id}|${id}`, route);
  });
  return out;
}
