import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { CATALOG_PIN } from "./constants";
import { compareControlId, orderFamiliesPresent } from "./control-order";
import { controlLabel } from "./map-view";
import type {
  AssessmentObjective,
  ControlStatements,
  MapBundle,
  MapConstraint,
  MapControlFacts,
  MapDirectedEdge,
  MapEnhancement,
  MapFamilyFact,
  PackageMapView,
  StatementNode,
  StatementParamRef,
  StatementPartRow,
} from "./types";

/**
 * Level 1 map truth is read from the pinned NIST SP 800-53 Rev 5.2.0 catalog and the
 * FedRAMP Rev5 Moderate profile. Design HTML hardcodes are not a source.
 *
 * Catalog: fixtures/rev5/NIST_SP-800-53_rev5_catalog-min.json
 *   catalog.groups[].controls[id].links[href=#<id> rel=related]
 * Profile: fixtures/rev5/fedramp-rev5-moderate-profile.json
 *   profile.imports[].include-controls[].with-ids
 *   profile.modify.set-parameters
 *   profile.modify.alters
 *
 * IN_SUBSET edges are catalog related links whose both ends are controls in the loaded
 * package. For fedramp-rev5-subset@2026.09 that is 45 directed edges / 30 undirected pairs.
 * Related targets outside the package stay on the side panel. They are not map nodes.
 *
 * Level 2 statement rows are catalog `parts[name=statement]` items. Assessment objectives
 * are catalog `parts[name=assessment-objective]` leaves. Profile constraints attach only
 * where `modify.set-parameters` names that param id. Item-level evidence is not in the
 * package IR and is not invented.
 */

const CATALOG_FILE = "NIST_SP-800-53_rev5_catalog-min.json";
const PROFILE_FILE = "fedramp-rev5-moderate-profile.json";
const CATALOG_UUID = "ea7c7688-79c5-463b-a91b-0650f2d98623";
const CATALOG_VERSION = "5.2.0";
const PROFILE_UUID = "2b52ae35-a912-4549-94db-5a43b6607f86";
const PROFILE_VERSION = "fedramp-3.0.0rc1-oscal-1.1.2";

const SUBSET_IDS = [
  "ac-2",
  "ac-3",
  "ac-6",
  "au-2",
  "au-6",
  "cm-2",
  "cm-6",
  "ia-2",
  "ia-5",
  "sc-7",
  "sc-8",
  "si-2",
] as const;

const NOTE_EMPTY = "Load a FedRAMP Rev5 package to read catalog related links.";
const NOTE_20X =
  "FedRAMP 20x stub has no NIST Rev5 related-control edges. Edges are not invented for placeholder controls.";
const NOTE_REV5 =
  "Links from the 800-53 Rev 5.2.0 catalog (rel=related). Baseline counts from the FedRAMP Rev5 Moderate profile. FAIL means required fields or evidence are missing, not authorization.";

type RawLink = { href?: string; rel?: string };
type RawProp = { name?: string; value?: string };
type RawPart = {
  id?: string;
  name?: string;
  prose?: string;
  props?: RawProp[];
  parts?: RawPart[];
};
type RawCatalogParam = { id?: string; label?: string };
type RawControl = {
  id?: string;
  title?: string;
  links?: RawLink[];
  controls?: RawControl[];
  parts?: RawPart[];
  params?: RawCatalogParam[];
};
type RawGroup = { id?: string; title?: string; controls?: RawControl[] };
type RawParam = { "param-id"?: string; constraints?: Array<{ description?: string }> };
type RawAlter = {
  "control-id"?: string;
  removes?: Array<{ "by-id"?: string }>;
  adds?: Array<{ parts?: Array<{ title?: string }> }>;
};

type ControlText = {
  statement: RawPart | null;
  objectives: RawPart | null;
  paramIds: string[];
};

type CatalogIndex = {
  catalogTitle: string;
  families: Map<string, { title: string; moderateBase: number }>;
  related: Map<string, string[]>;
  enhancementTitle: Map<string, string>;
  included: Set<string>;
  enhancementsByBase: Map<string, string[]>;
  constraintsByBase: Map<string, MapConstraint[]>;
  constraintByParam: Map<string, string>;
  paramLabel: Map<string, string>;
  textByControl: Map<string, ControlText>;
  altersById: Map<string, string>;
};

let indexCache: { root: string; index: CatalogIndex } | null = null;

export function rev5CatalogPath(root: string): string {
  return path.join(root, "fixtures", "rev5", CATALOG_FILE);
}

export function rev5ProfilePath(root: string): string {
  return path.join(root, "fixtures", "rev5", PROFILE_FILE);
}

export function unavailableMap(note: string): PackageMapView {
  return {
    level: 1,
    available: false,
    note,
    catalogVersion: null,
    catalogTitle: null,
    profileTitle: null,
    profileVersion: null,
    subsetPin: CATALOG_PIN,
    subsetMatch: false,
    directedInSubset: 0,
    undirectedPairs: 0,
    families: [],
    bundles: [],
    edges: [],
    byControl: {},
    statements: {},
  };
}

export function packageMapFor(
  root: string,
  catalogId: string | null,
  controls: Array<{ id: string; family: string }>,
): PackageMapView {
  if (catalogId === "fedramp-20x") return unavailableMap(NOTE_20X);
  if (catalogId !== "fedramp-rev5") return unavailableMap(NOTE_EMPTY);
  return projectRev5Map(loadRev5Index(root), controls);
}

export function loadRev5Index(root: string): CatalogIndex {
  if (indexCache?.root === root) return indexCache.index;
  const index = buildIndex(root);
  indexCache = { root, index };
  return index;
}

function buildIndex(root: string): CatalogIndex {
  const catalogDoc = JSON.parse(readFileSync(rev5CatalogPath(root), "utf8")) as {
    catalog?: { uuid?: string; metadata?: { title?: string; version?: string }; groups?: RawGroup[] };
  };
  const catalog = catalogDoc.catalog;
  if (!catalog) throw new Error(`${CATALOG_FILE} is missing catalog`);
  if (catalog.uuid !== CATALOG_UUID) {
    throw new Error(`${CATALOG_FILE} uuid ${catalog.uuid ?? ""} is not ${CATALOG_UUID}`);
  }
  if (catalog.metadata?.version !== CATALOG_VERSION) {
    throw new Error(`${CATALOG_FILE} version ${catalog.metadata?.version ?? ""} is not ${CATALOG_VERSION}`);
  }

  const profileDoc = JSON.parse(readFileSync(rev5ProfilePath(root), "utf8")) as {
    profile?: {
      uuid?: string;
      metadata?: { title?: string; version?: string };
      imports?: Array<{ "include-controls"?: Array<{ "with-ids"?: string[] }> }>;
      modify?: { "set-parameters"?: RawParam[]; alters?: RawAlter[] };
    };
  };
  const profile = profileDoc.profile;
  if (!profile) throw new Error(`${PROFILE_FILE} is missing profile`);
  if (profile.uuid !== PROFILE_UUID) {
    throw new Error(`${PROFILE_FILE} uuid ${profile.uuid ?? ""} is not ${PROFILE_UUID}`);
  }
  if (profile.metadata?.version !== PROFILE_VERSION) {
    throw new Error(`${PROFILE_FILE} version ${profile.metadata?.version ?? ""} is not ${PROFILE_VERSION}`);
  }

  const related = new Map<string, string[]>();
  const enhancementTitle = new Map<string, string>();
  const familyTitle = new Map<string, string>();
  const textByControl = new Map<string, ControlText>();
  const paramLabel = new Map<string, string>();
  for (const group of catalog.groups ?? []) {
    const familyId = (group.id ?? "").toUpperCase();
    if (familyId) familyTitle.set(familyId, group.title?.trim() || familyId);
    for (const control of group.controls ?? []) {
      if (!control.id) continue;
      const id = control.id.toLowerCase();
      related.set(id, relatedTargets(control));
      collectEnhancements(control, enhancementTitle);
      collectControlText(control, textByControl, paramLabel);
    }
  }

  const included = new Set<string>();
  for (const imported of profile.imports ?? []) {
    for (const block of imported["include-controls"] ?? []) {
      for (const id of block["with-ids"] ?? []) included.add(id.toLowerCase());
    }
  }

  const moderateBase = new Map<string, number>();
  for (const id of included) {
    if (!/^[a-z]{2}-\d+$/.test(id)) continue;
    const familyId = id.slice(0, 2).toUpperCase();
    moderateBase.set(familyId, (moderateBase.get(familyId) ?? 0) + 1);
  }

  const families = new Map<string, { title: string; moderateBase: number }>();
  for (const [id, title] of familyTitle) {
    families.set(id, { title, moderateBase: moderateBase.get(id) ?? 0 });
  }

  const enhancementsByBase = new Map<string, string[]>();
  for (const id of included) {
    const parent = enhancementParent(id);
    if (!parent) continue;
    const list = enhancementsByBase.get(parent) ?? [];
    list.push(id);
    enhancementsByBase.set(parent, list);
  }
  for (const [parent, list] of enhancementsByBase) {
    list.sort(compareControlId);
    enhancementsByBase.set(parent, list);
  }

  const constraintsByBase = new Map<string, MapConstraint[]>();
  const constraintByParam = new Map<string, string>();
  for (const param of profile.modify?.["set-parameters"] ?? []) {
    const paramId = param["param-id"]?.trim();
    if (!paramId) continue;
    const base = paramBase(paramId);
    if (!base) continue;
    const description = (param.constraints ?? [])
      .map((item) => item.description?.trim() ?? "")
      .filter(Boolean)
      .join("; ");
    const list = constraintsByBase.get(base) ?? [];
    list.push({ paramId, description });
    constraintsByBase.set(base, list);
    if (description) constraintByParam.set(paramId, description);
  }

  const altersById = new Map<string, string>();
  for (const alter of profile.modify?.alters ?? []) {
    const id = alter["control-id"]?.toLowerCase();
    if (!id) continue;
    altersById.set(id, summarizeAlter(alter));
  }

  return {
    catalogTitle: catalog.metadata?.title?.trim() || "NIST SP 800-53 Rev 5.2.0",
    families,
    related,
    enhancementTitle,
    included,
    enhancementsByBase,
    constraintsByBase,
    constraintByParam,
    paramLabel,
    textByControl,
    altersById,
  };
}

function projectRev5Map(index: CatalogIndex, controls: Array<{ id: string; family: string }>): PackageMapView {
  const displayByLower = new Map<string, string>();
  const familyByDisplay = new Map<string, string>();
  const seenFamilies: string[] = [];
  for (const control of controls) {
    const lower = control.id.toLowerCase();
    displayByLower.set(lower, control.id);
    familyByDisplay.set(control.id, control.family);
    if (!seenFamilies.includes(control.family)) seenFamilies.push(control.family);
  }
  const familyOrder = orderFamiliesPresent(seenFamilies, [...index.families.keys()]);
  const packageIds = new Set(displayByLower.keys());

  const edges: MapDirectedEdge[] = [];
  for (const control of controls) {
    const from = control.id.toLowerCase();
    for (const target of index.related.get(from) ?? []) {
      const toId = displayByLower.get(target);
      if (!toId) continue;
      const back = index.related.get(target) ?? [];
      edges.push({
        fromId: control.id,
        toId,
        mutual: back.includes(from),
        citation: `${CATALOG_FILE} catalog.groups[].controls[id=${from}].links[href=#${target} rel=related]`,
      });
    }
  }

  const undirected = new Map<string, { left: string; right: string }>();
  for (const edge of edges) {
    const [a, b] = [edge.fromId, edge.toId].sort();
    undirected.set(`${a}|${b}`, { left: a, right: b });
  }

  const within = new Map<string, number>();
  const bundleCounts = new Map<string, number>();
  for (const pair of undirected.values()) {
    const leftFamily = familyByDisplay.get(pair.left) ?? "";
    const rightFamily = familyByDisplay.get(pair.right) ?? "";
    if (!leftFamily || !rightFamily) continue;
    if (leftFamily === rightFamily) {
      within.set(leftFamily, (within.get(leftFamily) ?? 0) + 1);
      continue;
    }
    const [familyA, familyB] = orderFamilies(leftFamily, rightFamily, familyOrder);
    const key = `${familyA}|${familyB}`;
    bundleCounts.set(key, (bundleCounts.get(key) ?? 0) + 1);
  }

  const bundles: MapBundle[] = [...bundleCounts.entries()]
    .map(([key, pairs]) => {
      const [left, right] = key.split("|");
      return { left, right, pairs };
    })
    .sort((a, b) => familyOrder.indexOf(a.left) - familyOrder.indexOf(b.left)
      || familyOrder.indexOf(a.right) - familyOrder.indexOf(b.right));

  const families: MapFamilyFact[] = familyOrder.map((id) => {
    const known = index.families.get(id);
    return {
      id,
      title: known?.title ?? id,
      moderateBase: known ? known.moderateBase : null,
      withinPairs: within.get(id) ?? 0,
    };
  });

  const byControl: Record<string, MapControlFacts> = {};
  const statements: Record<string, ControlStatements> = {};
  for (const control of controls) {
    const lower = control.id.toLowerCase();
    const outside = (index.related.get(lower) ?? []).filter((id) => !packageIds.has(id));
    const requiredIds = (index.enhancementsByBase.get(lower) ?? []).filter((id) => !packageIds.has(id));
    const catalogEnhancements = [...index.enhancementTitle.keys()].filter((id) => enhancementParent(id) === lower);
    const requiredEnhancements: MapEnhancement[] = requiredIds.map((id) => ({
      id,
      label: controlLabel(id),
      title: index.enhancementTitle.get(id) ?? controlLabel(id),
    }));
    byControl[control.id] = {
      outOfSubset: outside.map(controlLabel),
      outOfSubsetCount: outside.length,
      requiredEnhancements,
      constraints: index.constraintsByBase.get(lower) ?? [],
      catalogOnlyEnhancementIds: catalogEnhancements
        .filter((id) => !index.included.has(id))
        .sort(compareControlId),
      alterSummary: index.altersById.get(lower) ?? null,
    };
    statements[control.id] = buildControlStatements(
      control.id,
      lower,
      index.textByControl.get(lower),
      index.paramLabel,
      index.constraintByParam,
    );
  }

  const subsetMatch = packageIds.size === SUBSET_IDS.length && SUBSET_IDS.every((id) => packageIds.has(id));

  return {
    level: 1,
    available: true,
    note: NOTE_REV5,
    catalogVersion: CATALOG_VERSION,
    catalogTitle: index.catalogTitle,
    profileTitle: "FedRAMP Rev 5 Moderate Baseline",
    profileVersion: PROFILE_VERSION,
    subsetPin: CATALOG_PIN,
    subsetMatch,
    directedInSubset: edges.length,
    undirectedPairs: undirected.size,
    families,
    bundles,
    edges,
    byControl,
    statements,
  };
}

function relatedTargets(control: RawControl): string[] {
  const seen = new Set<string>();
  const targets: string[] = [];
  for (const link of control.links ?? []) {
    if (link.rel !== "related" || !link.href) continue;
    const id = targetId(link.href);
    if (!id || id === control.id?.toLowerCase() || seen.has(id)) continue;
    seen.add(id);
    targets.push(id);
  }
  return targets;
}

function collectEnhancements(control: RawControl, titles: Map<string, string>) {
  for (const child of control.controls ?? []) {
    if (!child.id) continue;
    titles.set(child.id.toLowerCase(), child.title?.trim() || child.id);
    collectEnhancements(child, titles);
  }
}

function targetId(href: string): string | null {
  const trimmed = href.trim();
  const hash = trimmed.includes("#") ? trimmed.slice(trimmed.lastIndexOf("#") + 1) : trimmed;
  const id = hash.trim().toLowerCase();
  if (!/^[a-z]{2}-\d+(?:\.\d+)*$/.test(id)) return null;
  return id;
}

function enhancementParent(id: string): string | null {
  const match = /^([a-z]{2}-\d+)\.\d+/.exec(id);
  return match ? match[1] : null;
}

function paramBase(paramId: string): string | null {
  const match = /^([a-z]{2})-(\d+)/i.exec(paramId);
  if (!match) return null;
  return `${match[1].toLowerCase()}-${Number(match[2])}`;
}

export { compareControlId, orderFamiliesPresent } from "./control-order";

function orderFamilies(a: string, b: string, order: string[]): [string, string] {
  const ia = order.indexOf(a);
  const ib = order.indexOf(b);
  if (ia === -1 && ib === -1) return a < b ? [a, b] : [b, a];
  if (ib === -1 || (ia !== -1 && ia <= ib)) return [a, b];
  return [b, a];
}

function summarizeAlter(alter: RawAlter): string {
  const removes = (alter.removes ?? []).map((item) => item["by-id"]).filter((id): id is string => Boolean(id));
  const titles: string[] = [];
  for (const add of alter.adds ?? []) {
    for (const part of add.parts ?? []) {
      if (part.title?.trim()) titles.push(part.title.trim());
    }
  }
  const bits = [];
  if (removes.length) bits.push(`removes ${removes.join(", ")}`);
  if (titles.length) bits.push(`adds ${titles.join("; ")}`);
  return bits.length ? `Profile alter ${bits.join("; ")}` : "Profile alter";
}

const INSERT = /\{\{\s*insert:\s*param,\s*([^}\s]+)\s*\}\}/g;

function collectControlText(
  control: RawControl,
  into: Map<string, ControlText>,
  paramLabel: Map<string, string>,
) {
  if (!control.id) return;
  const id = control.id.toLowerCase();
  const parts = control.parts ?? [];
  into.set(id, {
    statement: parts.find((part) => part.name === "statement") ?? null,
    objectives: parts.find((part) => part.name === "assessment-objective") ?? null,
    paramIds: (control.params ?? []).map((param) => param.id?.trim() ?? "").filter(Boolean),
  });
  for (const param of control.params ?? []) {
    const paramId = param.id?.trim();
    if (!paramId) continue;
    paramLabel.set(paramId, (param.label ?? "").trim());
  }
}

function buildControlStatements(
  displayId: string,
  lower: string,
  text: ControlText | undefined,
  paramLabel: Map<string, string>,
  constraintByParam: Map<string, string>,
): ControlStatements {
  const paramIndex: ControlStatements["paramIndex"] = {};
  for (const paramId of text?.paramIds ?? []) {
    paramIndex[paramId] = {
      label: paramLabel.get(paramId) ?? "",
      constraint: constraintByParam.get(paramId) ?? null,
    };
  }
  const statement = text?.statement ?? null;
  if (!statement?.id) {
    return { controlId: displayId, statementId: null, items: [], parts: [], paramIndex };
  }
  const parts: StatementPartRow[] = [];
  flattenStatement(statement, 0, parts);
  const children = (statement.parts ?? []).filter((part) => part.id);
  const objectives = text?.objectives ?? null;
  const items = children.length > 0
    ? children.map((part) => toStatementNode(lower, part, 1, objectives, paramLabel, constraintByParam))
    : [toStatementNode(lower, statement, 0, objectives, paramLabel, constraintByParam)];
  return {
    controlId: displayId,
    statementId: statement.id,
    items,
    parts,
    paramIndex,
  };
}

function flattenStatement(part: RawPart, depth: number, out: StatementPartRow[]) {
  if (!part.id) return;
  out.push({
    id: part.id,
    name: part.name ?? "item",
    label: partLabel(part),
    prose: partProse(part),
    depth,
  });
  for (const child of part.parts ?? []) flattenStatement(child, depth + 1, out);
}

function toStatementNode(
  controlId: string,
  part: RawPart,
  depth: number,
  objectivesRoot: RawPart | null,
  paramLabel: Map<string, string>,
  constraintByParam: Map<string, string>,
): StatementNode {
  const id = part.id ?? "";
  const objective = id ? findPart(objectivesRoot, id.replace("_smt", "_obj")) : null;
  const objectives = objective ? objectiveLeaves(objective) : [];
  return {
    id,
    name: part.name ?? "item",
    label: partLabel(part),
    prose: partProse(part),
    depth,
    params: paramsOn(part, paramLabel, constraintByParam),
    children: (part.parts ?? [])
      .filter((child) => child.id)
      .map((child) => toStatementNode(controlId, child, depth + 1, objectivesRoot, paramLabel, constraintByParam)),
    objectives,
    objectiveCount: objectives.length,
    citation: `${CATALOG_FILE} catalog.groups[].controls[id=${controlId}].parts[id=${id}]`,
  };
}

function paramsOn(
  part: RawPart,
  paramLabel: Map<string, string>,
  constraintByParam: Map<string, string>,
): StatementParamRef[] {
  const prose = partProse(part);
  const found: StatementParamRef[] = [];
  const seen = new Set<string>();
  for (const match of prose.matchAll(INSERT)) {
    const paramId = match[1];
    if (!paramId || seen.has(paramId)) continue;
    seen.add(paramId);
    found.push({
      paramId,
      label: paramLabel.get(paramId) ?? "",
      itemId: part.id ?? "",
      itemLabel: partLabel(part),
      constraint: constraintByParam.get(paramId) ?? null,
    });
  }
  return found;
}

function objectiveLeaves(part: RawPart): AssessmentObjective[] {
  const kids = (part.parts ?? []).filter((child) => child.id);
  if (kids.length === 0) {
    return [{ id: part.id ?? "", label: partLabel(part) ?? "", prose: partProse(part) }];
  }
  return kids.flatMap(objectiveLeaves);
}

function findPart(part: RawPart | null, id: string): RawPart | null {
  if (!part) return null;
  if (part.id === id) return part;
  for (const child of part.parts ?? []) {
    const hit = findPart(child, id);
    if (hit) return hit;
  }
  return null;
}

function partLabel(part: RawPart): string | null {
  for (const prop of part.props ?? []) {
    if (prop.name === "label" && prop.value?.trim()) return prop.value.trim();
  }
  return null;
}

function partProse(part: RawPart): string {
  return (part.prose ?? "").replace(/\s+/g, " ").trim();
}

export function sha256File(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

export type CatalogStatementItem = {
  id: string;
  label: string | null;
  prose: string;
};

/** Direct statement items for one Rev5 control, for example `cm-6_smt.a`. The statement root is not an item. */
export function rev5StatementItems(root: string, controlId: string): CatalogStatementItem[] {
  const text = loadRev5Index(root).textByControl.get(controlId.trim().toLowerCase());
  const children = (text?.statement?.parts ?? []).filter((part) => part.id);
  return children.map((part) => ({
    id: part.id ?? "",
    label: partLabel(part),
    prose: partProse(part),
  }));
}
