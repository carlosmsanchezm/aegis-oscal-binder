import type { CoverageFamily } from "./baseline-coverage";
import type { ControlRollupRow } from "./control-rollup";
export function footprintRows(families: CoverageFamily[], suggested: ReadonlySet<string> = new Set()) {
  const all = families.flatMap(f => f.controls);
  const row = (id: string, title: string, controls: ControlRollupRow[], kind: "all" | "sub" | "family") => ({ id, title, kind, evidence: controls.filter(r => r.result).length, suggested: controls.filter(r => !r.result && suggested.has(r.id)).length, total: controls.length });
  return [row("All controls", "", all, "all"), row("Base", "", all.filter(r => !r.enhancement), "sub"), row("Enhancements", "", all.filter(r => r.enhancement), "sub"), ...families.map(f => row(f.id, f.title, f.controls, "family"))];
}
