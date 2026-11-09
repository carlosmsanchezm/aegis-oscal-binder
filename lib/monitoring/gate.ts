import { monitoringCopy } from "./copy";
import type { DriftRow } from "./types";

export type GateMode = "report" | "enforce";

export type GateReport = {
  title: string;
  mode: GateMode;
  exitCode: 0 | 1;
  summary: string;
  blocking: DriftRow[];
  rows: DriftRow[];
};

export function parseAllowlist(value: string | undefined): Set<string> {
  return new Set((value ?? "").split(",").map(item => item.trim().toUpperCase()).filter(Boolean));
}

/** Report-only unless mode is enforce. Only a pass that became a fail can block, and an allowlist entry exempts it. */
export function evaluateGate(rows: DriftRow[], allow: Set<string>, mode: GateMode = "report"): GateReport {
  const blocking = rows.filter(row => row.regression && !allow.has(row.subjectId.toUpperCase()));
  const exitCode: 0 | 1 = mode === "enforce" && blocking.length > 0 ? 1 : 0;
  return {
    title: monitoringCopy.gateTitle,
    mode,
    exitCode,
    summary: exitCode === 1 ? monitoringCopy.gateBlocking : monitoringCopy.gateClear,
    blocking,
    rows,
  };
}
