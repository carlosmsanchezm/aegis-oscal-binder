import type { evidenceByControl } from "../collector/control-evidence";
import { planNeedsDecision } from "../collector/control-evidence";
import type { PlanProposal } from "./plan-proposal";
export type EvidenceControl = ReturnType<typeof evidenceByControl>["controls"][number];
export type EvidenceFile = EvidenceControl["evidence"][number];
export type EvidenceLink = { controlId: string; kind: "E" | "S" };
export const GRAPH = { leftWidth: 280, rightX: 400, rightWidth: 280, fileHeight: 44, controlHeight: 46, gap: 8, max: 8, big: 92 } as const;
export function evidencePath(file: EvidenceFile) { return file.collected?.source.path ?? file.name; }
export function evidenceFolder(path: string) { const i = path.lastIndexOf("/"); if (i < 0) return ""; const dir = path.slice(0, i + 1); return dir.length > 38 ? "…" + dir.slice(-37) : dir; }
export function visibleGraphRows<T>(rows: T[], expanded: boolean) { const shown = rows.length > GRAPH.max && !expanded ? rows.slice(0, GRAPH.max - 1) : rows; return { shown, more: rows.length - shown.length }; }
export function graphGeometry(count: number, nodeHeight: number = GRAPH.fileHeight) { const stack = count * (nodeHeight + GRAPH.gap) - GRAPH.gap; const height = Math.max(stack, GRAPH.big); return { height, top: Math.max(0, (height - stack) / 2), center: (height - GRAPH.big) / 2 }; }
export function evidenceGraph(controls: EvidenceControl[], plans: PlanProposal[] = [], selected?: string | null) {
  const linked = controls.filter(c => c.evidence.length || c.suggested.length);
  const decisions = (id: string) => plans.filter(p => p.controlId === id && planNeedsDecision(p)).length;
  const active = linked.find(c => c.id === selected) ?? linked.find(c => decisions(c.id)) ?? linked[0];
  const files = new Map<string, { key: string; path: string; links: EvidenceLink[] }>();
  for (const c of linked) for (const kind of ["E", "S"] as const) for (const f of kind === "E" ? c.evidence : c.suggested) {
    const entry = files.get(f.key) ?? { key: f.key, path: evidencePath(f), links: [] };
    if (!entry.links.some(l => l.controlId === c.id)) entry.links.push({ controlId: c.id, kind });
    files.set(f.key, entry);
  }
  return { controls: linked, files: [...files.values()], active, decisions, evidenceCount: linked.filter(c => c.evidence.length).length, suggestedCount: linked.filter(c => c.suggested.length).length };
}
