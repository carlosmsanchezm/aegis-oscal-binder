import { MODERATE_BASELINE_COUNT } from "./moderate-baseline";
import type { ItemStatementRecord, MapDirectedEdge, MapGlyph, StatementNode, StatementParamRef } from "./types";

export type DirectedLink = {
  otherId: string;
  glyph: MapGlyph;
  citation: string;
};

/** Split in-package catalog edges around the selected control. Mutual pairs are not also listed as reverse. */
export function directedLinksFor(edges: MapDirectedEdge[], selectedId: string): {
  mutual: DirectedLink[];
  outbound: DirectedLink[];
  reverse: DirectedLink[];
} {
  const mutual: DirectedLink[] = [];
  const outbound: DirectedLink[] = [];
  const reverse: DirectedLink[] = [];
  for (const edge of edges) {
    if (edge.fromId === selectedId) {
      if (edge.mutual) mutual.push({ otherId: edge.toId, glyph: "mutual", citation: edge.citation });
      else outbound.push({ otherId: edge.toId, glyph: "outbound", citation: edge.citation });
    } else if (edge.toId === selectedId && !edge.mutual) {
      reverse.push({ otherId: edge.fromId, glyph: "reverse", citation: edge.citation });
    }
  }
  return { mutual, outbound, reverse };
}

/** `ac-17_smt` is the whole control. `ac-17_smt.a` is an item. */
export function isStatementItemId(statementId: string): boolean {
  return /_smt\.[a-z0-9]/i.test(statementId);
}

export function itemEvidenceLinks(control: {
  itemStatements?: ItemStatementRecord[];
  evidence: ReadonlyArray<{ id: string; uuid: string }>;
}): Array<{ statementId: string; evidenceId: string }> {
  const byUuid = new Map(control.evidence.map((item) => [item.uuid, item.id]));
  const links: Array<{ statementId: string; evidenceId: string }> = [];
  for (const statement of control.itemStatements ?? []) {
    if (!isStatementItemId(statement.statementId)) continue;
    for (const uuid of statement.evidenceUuids) {
      const evidenceId = byUuid.get(uuid);
      if (!evidenceId) continue;
      links.push({ statementId: statement.statementId, evidenceId });
    }
  }
  return links;
}

/** Level 2 evidence column kicker. Whole-control links are not item links. */
export function evidenceColumnKicker(itemLinkCount: number): string {
  return itemLinkCount > 0 ? "Evidence · mapped to items" : "Evidence · not mapped to items";
}

export function statementAddressed(control: { itemStatements?: ItemStatementRecord[] }, statementId: string): boolean {
  const statement = (control.itemStatements ?? []).find((item) => item.statementId === statementId);
  return Boolean(statement?.description.trim());
}

/** Coverage is informational, separate from the control-level export gate and effectiveness. */
export function statementCoverage(control: { itemStatements?: ItemStatementRecord[]; evidence: ReadonlyArray<{ id: string; uuid: string }> }, items: StatementNode[]) {
  const linked = new Set(itemEvidenceLinks(control).map((link) => link.statementId));
  return items.map((item) => ({ id: item.id, state: statementAddressed(control, item.id) ? linked.has(item.id) ? "linked" as const : "addressed" as const : "empty" as const }));
}

/**
 * Axis-aligned span of the controls a shared role or evidence item covers.
 * The same role on AC-3 and IA-2 becomes one chip from the left edge of AC-3 to the right edge of IA-2.
 */
export function spanInterval(
  boxes: Array<{ id: string; x: number; w: number }>,
  ids: string[],
): { x: number; w: number } | null {
  const picked = boxes.filter((box) => ids.includes(box.id));
  if (picked.length === 0) return null;
  const x = Math.min(...picked.map((box) => box.x));
  const right = Math.max(...picked.map((box) => box.x + box.w));
  return { x, w: right - x };
}

export type ProseSegment = {
  kind: "text" | "constraint" | "open";
  text: string;
  paramId?: string;
};

/** Split catalog prose on `{{ insert: param, id }}` and mark FedRAMP constraints vs organization-defined labels. */
export function proseSegments(
  prose: string,
  index: Record<string, { label: string; constraint: string | null }>,
): ProseSegment[] {
  const pattern = /\{\{\s*insert:\s*param,\s*([^}\s]+)\s*\}\}/g;
  const segments: ProseSegment[] = [];
  let last = 0;
  for (const match of prose.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start > last) segments.push({ kind: "text", text: prose.slice(last, start) });
    const paramId = match[1] ?? "";
    const known = index[paramId];
    if (known?.constraint) segments.push({ kind: "constraint", text: known.constraint, paramId });
    else segments.push({ kind: "open", text: known?.label?.trim() || paramId, paramId });
    last = start + match[0].length;
  }
  if (last < prose.length) segments.push({ kind: "text", text: prose.slice(last) });
  if (segments.length === 0) segments.push({ kind: "text", text: prose });
  return segments;
}

/** Plain-text rendering for dialogs, tooltips and evidence details; never expose OSCAL insert syntax. */
export function resolvedStatementProse(prose:string,index:Record<string,{label:string;constraint:string|null}>={}) {
  return proseSegments(prose,index).map(segment=>segment.kind==='text'||segment.kind==='constraint'?segment.text:`[Organization-defined parameter: ${segment.text}]`).join('');
}

/** Inserts on this part and its descendants, in catalog order. */
export function descendantParams(node: StatementNode): StatementParamRef[] {
  const out: StatementParamRef[] = [];
  const seen = new Set<string>();
  function walk(current: StatementNode) {
    for (const param of current.params) {
      const key = `${param.itemId}|${param.paramId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(param);
    }
    for (const child of current.children) walk(child);
  }
  walk(node);
  return out;
}

export function findStatement(items: StatementNode[], id: string): StatementNode | null {
  for (const item of items) {
    if (item.id === id) return item;
    const child = findStatement(item.children, id);
    if (child) return child;
  }
  return null;
}

/** `ac-02.02_odp.01` belongs to enhancement `ac-2.2`. Base params such as `ac-02_odp.06` return null. */
export function enhancementOfParam(paramId: string): string | null {
  const match = /^([a-z]{2})-0*(\d+)\.0*(\d+)_/i.exec(paramId.trim());
  if (!match) return null;
  return `${match[1].toLowerCase()}-${match[2]}.${match[3]}`;
}

/** Base-control constraints stay in the grid. Enhancement constraints outside the package become one count. */
export function partitionConstraints<T extends { paramId: string }>(
  constraints: readonly T[],
  packageIds: ReadonlySet<string>,
): { base: T[]; more: number } {
  const base: T[] = [];
  let more = 0;
  for (const item of constraints) {
    const enhancement = enhancementOfParam(item.paramId);
    if (enhancement && !packageIds.has(enhancement)) more += 1;
    else base.push(item);
  }
  return { base, more };
}

/**
 * Short label from the statement text around a parameter insert.
 * Uses words that are already in that prose, then the catalog label.
 */
export function parameterPhrase(paramId: string, items: readonly StatementNode[], catalogLabel: string): string {
  const found = findInsert(items, paramId, null);
  const fallback = catalogLabel.trim();
  if (!found) return fallback || paramId;
  const after = clauseAfter(found.node.prose, paramId);
  if (after) {
    const lead = found.parent ? leadingWord(found.parent.prose) : "";
    const first = after.split(/\s+/)[0] ?? "";
    if (lead && lead !== first) return `${lead}: ${after}`;
    return after;
  }
  const before = clauseBefore(found.node.prose, paramId);
  return before || fallback || paramId;
}

function findInsert(
  items: readonly StatementNode[],
  paramId: string,
  parent: StatementNode | null,
): { node: StatementNode; parent: StatementNode | null } | null {
  for (const item of items) {
    if (insertPattern(paramId).test(item.prose)) return { node: item, parent };
    const child = findInsert(item.children, paramId, item);
    if (child) return child;
  }
  return null;
}

function insertPattern(paramId: string): RegExp {
  return new RegExp(`\\{\\{\\s*insert:\\s*param,\\s*${paramId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\}\\}`, "i");
}

function clauseAfter(prose: string, paramId: string): string {
  const match = insertPattern(paramId).exec(prose);
  if (!match || match.index == null) return "";
  return cleanClause(prose.slice(match.index + match[0].length));
}

function clauseBefore(prose: string, paramId: string): string {
  const match = insertPattern(paramId).exec(prose);
  if (!match || match.index == null) return "";
  return cleanClause(prose.slice(0, match.index));
}

function cleanClause(text: string): string {
  const stripped = text
    .replace(/\{\{[^}]+\}\}/g, " ")
    .replace(/[;:.,]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(when|within|and|or)\s+/i, "")
    .replace(/\s+(and|or)$/i, "");
  return stripped.toLowerCase();
}

function leadingWord(prose: string): string {
  const cleaned = prose.replace(/\{\{[^}]+\}\}/g, " ").replace(/[^A-Za-z\s]/g, " ").replace(/\s+/g, " ").trim();
  const word = cleaned.split(" ").find((part) => part.length > 2);
  return word ? word.toLowerCase() : "";
}

/** `ac-02_odp.01` → `odp.01`. */
export function openParamChip(paramId: string): string {
  const index = paramId.toLowerCase().indexOf("odp");
  return index >= 0 ? paramId.slice(index) : paramId;
}

/**
 * Chip text for a statement row.
 * A profile constraint uses the catalog sub-item label (`h.1`) and the profile sentence.
 * An unconstrained parameter uses its odp id only.
 */
export function paramChip(parentLabel: string | null, param: StatementParamRef): { tone: "constraint" | "open"; text: string } {
  if (param.constraint) {
    const where = constraintWhere(parentLabel, param);
    return { tone: "constraint", text: where ? `${where} · ${param.constraint}` : param.constraint };
  }
  return { tone: "open", text: openParamChip(param.paramId) };
}

function constraintWhere(parentLabel: string | null, param: StatementParamRef): string | null {
  if (!param.itemLabel || !parentLabel || param.itemLabel === parentLabel) return openParamChip(param.paramId);
  const parent = parentLabel.replace(/\.$/, "");
  const child = param.itemLabel.replace(/\.$/, "");
  if (!parent || !child) return openParamChip(param.paramId);
  return `${parent}.${child}`;
}

const HOUR_24 = /twenty-four \(24\) hours|24 hours/i;
const HOUR_8 = /eight \(8\) hours|8 hours/i;
const QUARTER = /quarterly for privileged access,\s*annually for non-privileged access/i;

/** Short chip text so a Level 2 row stays on one line. */
export function compactConstraint(text: string): string {
  if (HOUR_24.test(text)) return "24 h";
  if (HOUR_8.test(text)) return "8 h";
  if (QUARTER.test(text)) return "quarterly priv / annual";
  const trimmed = text.replace(/\s+/g, " ").trim();
  return trimmed.length > 28 ? `${trimmed.slice(0, 26)}…` : trimmed;
}

/** Chip and note. The digit 12 appears only when the loaded ids are the 12-control subset. */
export function scopeChip(subsetMatch: boolean, count: number, label = "FedRAMP Rev5"): string {
  if (subsetMatch) return `${label} · ${count}-control subset`;
  const noun = count === 1 ? "control" : "controls";
  return `${label} · ${count} ${noun}`;
}

export function subsetBaselineNote(subsetMatch: boolean, count: number): string {
  if (subsetMatch) return "Subset of 12 controls, not the full Moderate baseline";
  if (count === MODERATE_BASELINE_COUNT) {
    return "FedRAMP Rev 5 Moderate baseline. A control with no stored evidence is blank. Membership is not a pass or an authorization.";
  }
  const noun = count === 1 ? "control" : "controls";
  return `${count} ${noun} in this package, not the full Moderate baseline`;
}

/** Family-bundle count chip. A single relationship has no badge. */
export function bundleCountBadge(count: number): string | null {
  if (count < 2) return null;
  return String(count);
}

/** Visible evidence line. Singular when the count is 1. No abbreviations. */
export function evidenceCountLine(controlCount: number, familyCount: number): string {
  const controls = `${controlCount} ${controlCount === 1 ? "control" : "controls"}`;
  if (familyCount <= 1) return controls;
  const families = `${familyCount} ${familyCount === 1 ? "family" : "families"}`;
  return `${controls} · ${families}`;
}

/** One grey line for the Level 2 breadcrumb: package fail, then the catalog honesty. */
export function focusBarNote(
  controlId: string | null,
  controls: ReadonlyArray<{ id: string; complete: boolean; missing: string[] }>,
  gateStatus: string,
  catalogVersion: string | null,
): string {
  const honesty = `Links from the 800-53 Rev ${catalogVersion ?? "5.2.0"} catalog; baseline counts from the FedRAMP Rev5 Moderate profile. FAIL = missing required fields or evidence, not authorization.`;
  const anchor = controlId && controls.some((control) => control.id === controlId && control.complete)
    ? controlId
    : controls.find((control) => control.complete)?.id ?? null;
  const fail = anchor ? packageStillFails(anchor, controls, gateStatus) : null;
  if (!fail) return honesty;
  if (controlId && anchor === controlId) return `${fail} ${honesty}`;
  return `${fail.replace(/^This control is complete\. /, "")} ${honesty}`;
}

export function packageStillFails(
  controlId: string,
  controls: ReadonlyArray<{ id: string; complete: boolean; missing: string[] }>,
  gateStatus: string,
): string | null {
  if (gateStatus !== "FAIL") return null;
  const self = controls.find((control) => control.id === controlId);
  if (!self?.complete) return null;
  const others = controls.filter((control) => !control.complete);
  if (others.length === 0) return null;
  const bits = others.map((control) => {
    const gaps = control.missing.map(gapPhrase);
    const joined = gaps.length <= 1 ? gaps[0] ?? "a required field" : `${gaps.slice(0, -1).join(", ")} and ${gaps.at(-1)}`;
    return `${control.id} is missing ${joined}`;
  });
  return `This control is complete. The package still fails because ${bits.join("; ")}.`;
}

function gapPhrase(missing: string): string {
  if (missing === "responsibleRole") return "a responsible role";
  if (missing === "evidence") return "evidence";
  if (missing === "implementation") return "an implementation";
  return missing;
}

/** `ac-2` → `AC-2`, `ac-2.1` → `AC-2(1)`. */
export function controlLabel(id: string): string {
  const parts = id.toLowerCase().split(".");
  const base = parts[0].toUpperCase();
  if (parts.length === 1) return base;
  return `${base}(${parts.slice(1).join(")(")})`;
}

/** Distinct catalog control pairs grouped by other family, relative to the selected family. */
export function familyRelationships(edges:MapDirectedEdge[],family:string) {
  const families=new Map<string,{mutual:Set<string>;outbound:Set<string>;reverse:Set<string>}>();
  for(const edge of edges){const from=edge.fromId.split("-")[0],to=edge.toId.split("-")[0];if(from===to||from!==family&&to!==family)continue;const other=from===family?to:from;let counts=families.get(other);if(!counts){counts={mutual:new Set(),outbound:new Set(),reverse:new Set()};families.set(other,counts);}const pair=[edge.fromId,edge.toId].sort().join("|");counts[edge.mutual?"mutual":from===family?"outbound":"reverse"].add(pair);}
  return [...families].map(([id,c])=>({id,mutual:c.mutual.size,outbound:c.outbound.size,reverse:c.reverse.size})).sort((a,b)=>a.id.localeCompare(b.id));
}
