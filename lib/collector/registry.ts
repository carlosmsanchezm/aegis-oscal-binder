/**
 * Platform format registry.
 *
 * Every evidence schema id and source kind used by a collector has to be
 * listed here. test/platform-format.test.ts fails when lib/ adds a schema
 * id or an evidence export that is not registered.
 */

export const SOURCE_KINDS = ["scan-result", "release-asset", "aws-account"] as const;

export type SourceKind = (typeof SOURCE_KINDS)[number];

export const SCHEMA_IDS = [
  "aegis.collected-artifact.v1",
  "aegis.evidence-event.v1",
  "aegis.evidence-bundle.v1",
  "aegis.aws-scan-record/v1",
  "ccm.application-evidence.v1",
  "binder.plan-proposal.v1",
  "binder.pull-request-link.v1",
  "binder.release-evidence.v1",
  "binder.remediation-draft.v1",
  "aegis.source-capture.v1",
  "binder.agent-run.v1",
  "binder.fix-runner.v1",
  "binder.agent-activity.v1",
  "binder.timeline-entry.v1",
  "binder.evidence-manifest.v1",
  "binder.gate-audit.v1",
  "binder.gate-case.v1",
] as const;

export type SchemaId = (typeof SCHEMA_IDS)[number];

/** Export names the platform-format test treats as evidence types. */
export const EVIDENCE_EXPORTS = [
  "AwsScanRecord",
  "CollectedArtifact",
  "EvidenceControl",
  "EvidenceFile",
  "EvidenceLink",
  "EvidenceBundle",
  "EvidenceConnection",
  "EvidenceEvent",
  "EvidenceFact",
  "EvidenceInput",
  "EvidenceProblem",
  "EvidenceRecord",
  "EvidenceSource",
  "AwsEvidenceSource",
  "GitEvidenceSource",
  "EvidenceSourceLabel",
  "EvidenceType",
  "EvidenceView",
  "LegacyPipelineEvidence",
  "PipelineEvidence",
  "ReleaseEvidence",
  "ReleaseItem",
  "SourceKind",
  "SystemObservationEvidence",
] as const;

export function assertSchemaId(id: string): asserts id is SchemaId {
  if (!(SCHEMA_IDS as readonly string[]).includes(id)) {
    throw new Error(`Schema ${id} is not registered in lib/collector/registry.ts.`);
  }
}

export function assertSourceKind(kind: string): asserts kind is SourceKind {
  if (!(SOURCE_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`Source kind ${kind} is not registered in lib/collector/registry.ts.`);
  }
}
