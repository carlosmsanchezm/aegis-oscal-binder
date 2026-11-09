import type { RemediationPlan } from "../aegis/remediation";
import type { ReviewObservation } from "../aegis/review-context";
import type { PlanDecision } from "../aegis/plan-proposal";
import type { CollectedArtifact } from "../collector/types";
import type copy from "../../catalogs/monitoring-copy.json";

export type DriftClass = keyof typeof copy.classes;
export type SubjectKind = "control" | "ksi";
export type MonitorOutcome = "pass" | "fail" | "absent";

/** One platform capture. Collectors return this document and nothing else. */
export type SourceCaptureDocument = {
  schema: "aegis.source-capture.v1";
  captures: Array<{
    source: { repo: string; commit: string; capturedAt: string };
    artifacts: CollectedArtifact[];
    excluded?: { path: string; reason: string }[];
  }>;
};

export type ScanTrigger = {
  kind: "webhook" | "ci" | "schedule";
  event?: "push" | "merge";
  repo: string;
  revision: string;
  at: string;
  runId?: string;
};

export type DriftRow = {
  subjectId: string;
  subjectKind: SubjectKind;
  drift: DriftClass;
  label: string;
  previous: MonitorOutcome;
  outcome: MonitorOutcome;
  regression: boolean;
  regressionLabel: string;
  artifactNames: string[];
};

/** Dated result for one control or KSI. `prevHash` is the prior entry's `entryHash`. */
export type MonitorTimelineEntry = {
  captureSchema: "aegis.source-capture.v1";
  connectionId: string;
  sourceId: string;
  subjectId: string;
  subjectKind: SubjectKind;
  capturedAt: string;
  outcome: MonitorOutcome;
  drift: DriftClass;
  label: string;
  previous: MonitorOutcome;
  regression: boolean;
  regressionLabel: string;
  captureSha256: string;
  artifactNames: string[];
  problem?: ReviewObservation;
  draft?: { plan: RemediationPlan; decision: PlanDecision };
  prevHash: string;
  entryHash: string;
};

export type StoredMonitorResult = {
  captureSha256: string;
  sourceIds: string[];
  trigger: ScanTrigger;
  drift: DriftRow[];
  entries: MonitorTimelineEntry[];
  evidenceIds: string[];
  replayed: boolean;
};
