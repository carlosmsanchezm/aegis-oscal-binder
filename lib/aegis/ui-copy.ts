/**
 * Short labels for the demo workspace: tile captions, panel block titles and
 * step names. Explanations stay in the components behind Details or info toggles.
 */
import { DOT } from "@/lib/m1/copy";

export const SUMMARY = {
  families: "Families touched",
  linked: "Linked",
  proposed: "Proposed",
  versions: "Versions",
  details: "Details",
  limits: `Agent proposes ${DOT} person approves ${DOT} coverage only`,
} as const;

export const RELEASE_METRICS = {
  coverage: "Coverage",
} as const;

export const NEXT_WORK = {
  finding: "Finding",
  proposals: "Proposed",
  blank: "Blank",
} as const;

export const CONTROL_PANEL = {
  status: "Status",
  evidence: "Evidence",
  next: "Next action",
  related: (count: number, families: number) => `Relationships ${DOT} ${count} in ${families} families`,
  noEvidence: "None linked",
  controlLevel: "control level",
} as const;

export const SYSTEM_SOURCES = {
  label: "System sources:",
  note: "captured measurements are separate",
} as const;

export const PLAN_STEPS = ["Review", "Edit", "Accept", "Retest", "Close"] as const;
export type PlanStep = (typeof PLAN_STEPS)[number];

export const CONNECTIONS = {
  info: (name: string) => `About ${name}`,
  artifacts: (n: number) => `${n} artifact${n === 1 ? "" : "s"}`,
} as const;
