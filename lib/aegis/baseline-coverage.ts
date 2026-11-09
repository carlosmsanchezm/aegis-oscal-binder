import { evidenceForRelease, rollupControlResults, type ControlRollupRow } from "./control-rollup";
import { moderateFamilies } from "./moderate-baseline";
import type { PipelineEvidence } from "./pipeline-evidence";

export type CoverageFilter = "all" | "linked" | "blank" | "review";
export type CoverageFamily = { id: string; title: string; controls: ControlRollupRow[] };
export function coverageMatches(row: ControlRollupRow, filter: CoverageFilter): boolean {
  return filter === "all" || (filter === "linked" ? Boolean(row.result) : filter === "blank" ? !row.result : Boolean(row.result?.finding));
}
export function coverageCounts(rows: ControlRollupRow[]) {
  const linked = rows.filter(r => r.result).length;
  return { all: rows.length, linked, blank: rows.length - linked, review: rows.filter(r => r.result?.finding).length };
}
export function coverageFamilies(record: PipelineEvidence, history: PipelineEvidence[], accumulated: boolean): CoverageFamily[] {
  const releaseResults = evidenceForRelease(record, history);
  const rows = rollupControlResults(accumulated ? history : [], record.pipelineUrl);
  return moderateFamilies().map(family => ({ ...family, controls: rows.filter(r => r.family === family.id).map(row => accumulated ? row : { ...row, result: releaseResults.get(row.id) ?? null }) }));
}
export function coverageSource(row: ControlRollupRow, history: PipelineEvidence[]): PipelineEvidence | undefined {
  const result = row.result;
  return result ? history.find(r => r.pipelineUrl === result.releaseUrl && r.commitSha === result.commit && r.releaseSha256 === result.releaseSha256) : undefined;
}
