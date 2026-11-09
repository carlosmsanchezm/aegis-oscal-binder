import { parseReviewObservations } from "./review-context";
import { pipelineArtifactNames } from "./pipeline-evidence";
import type { LegacyPipelineEvidence, PipelineCheck, PipelineEvidence, PipelineFamily } from "./pipeline-evidence";
import { parsePipelineVerification } from "./pipeline-verification";

/** Vendor-neutral event any pipeline can POST. Not a vendor webhook payload. */
export const PIPELINE_EVENT_SCHEMA = "aegis.pipeline-event.v1";
export const PIPELINE_WEBHOOK_PATH = "/api/pipeline/events";
export const PIPELINE_WEBHOOK_HEADER = "x-aegis-signature";

export type PipelineConnection = {
  configured: boolean | null;
  webhookPath: string;
  receivedAt: string | null;
  inboundSelected: boolean;
};

const MAX_BODY_FIELDS = 40;

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Expected ${label} to be an object.`);
  return value as Record<string, unknown>;
}

function str(value: unknown, label: string, max = 1000): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u001f]/.test(value)) {
    throw new Error(`Missing or invalid ${label}.`);
  }
  return value.trim();
}

function count(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${label}.`);
  return value;
}

function optionalCount(value: unknown, label: string): number | null {
  return value == null ? null : count(value, label);
}

function names(value: unknown, label: string, max = 80): string[] {
  if (!Array.isArray(value) || value.length > MAX_BODY_FIELDS) throw new Error(`Invalid ${label}.`);
  return value.map((item) => safeName(item, label, max));
}

function sentences(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_BODY_FIELDS) throw new Error(`Invalid ${label}.`);
  return value.map((item) => str(item, label, 1000));
}

function safeName(value: unknown, label: string, max = 80): string {
  const name = str(value, label, max);
  if (!/^[A-Za-z0-9_.-]{1,80}$/.test(name) || name.includes("..")) throw new Error(`Invalid ${label}.`);
  return name;
}

function httpsUrl(value: unknown, label: string): string {
  const raw = str(value, label, 500);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid ${label}.`);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.href.length > 500) throw new Error(`Invalid ${label}.`);
  return url.href;
}

function checksOf(value: unknown): PipelineCheck[] {
  if (!Array.isArray(value) || value.length > 50) throw new Error("Invalid checks or control mappings.");
  return value.map((item) => {
    const check = object(item, "check");
    return {
      id: safeName(check.id, "check ID"),
      status: str(check.status, "check status", 50),
      findings: optionalCount(check.findings, "findings"),
      blockingCount: optionalCount(check.blockingCount, "blocking count"),
      artifact: safeName(check.artifact, "check artifact"),
    };
  });
}

function familiesOf(value: unknown): PipelineFamily[] {
  if (!Array.isArray(value) || value.length > 30) throw new Error("Invalid checks or control mappings.");
  return value.map((item) => {
    const family = object(item, "family");
    return {
      family: safeName(family.family, "family", 10),
      controls: names(family.controls, "controls"),
      coverage: str(family.coverage, "coverage"),
      evidence: names(family.evidence, "evidence"),
    };
  });
}

/** Map one posted event into the release evidence shape. A pass is not validation or closure. */
export function normalizePipelineEvent(input: unknown): LegacyPipelineEvidence {
  const event = object(input, "pipeline event");
  if (event.schema !== PIPELINE_EVENT_SCHEMA) throw new Error("Unsupported pipeline event schema. Expected aegis.pipeline-event.v1.");
  const pipeline = object(event.pipeline, "pipeline");
  const approval = object(event.approval, "approval");
  const runtime = object(event.runtime, "runtime");
  const commitSha = str(pipeline.commit, "commit", 100);
  const releaseSha256 = str(event.releaseSha256, "release hash", 100);
  const podCount = count(runtime.podCount, "pod count");
  const readyCount = count(runtime.readyCount, "ready count");
  const meshSidecarCount = count(runtime.meshSidecarCount, "mesh sidecar count");
  if (readyCount > podCount || meshSidecarCount > podCount) throw new Error("Invalid runtime counts.");
  const evidence: LegacyPipelineEvidence = {
    schema: "ccm.application-evidence.v1",
    source: "Inbound pipeline event",
    ...(event.systemName == null ? {} : {systemName:str(event.systemName,"system name",200)}),
    pipelineId: safeName(pipeline.id, "pipeline ID"),
    pipelineUrl: httpsUrl(pipeline.url, "pipeline URL"),
    artifactJobId: event.artifactRef == null || event.artifactRef === "" ? "" : safeName(event.artifactRef, "artifact reference"),
    commitSha,
    image: str(event.image, "image", 500),
    createdAt: str(pipeline.createdAt, "creation time", 100),
    releaseSha256,
    policyVerdict: str(event.policyVerdict, "policy verdict", 50),
    signatureStatus: str(event.signatureStatus, "signature status", 50),
    signatureScope: str(event.signatureScope, "signature scope"),
    deploymentVerdict: str(event.deploymentVerdict, "deployment verdict", 50),
    approval: {
      actor: str(approval.actor, "approval actor", 100),
      approvedAt: str(approval.approvedAt, "approval time", 100),
      commitSha: str(approval.commit, "approval commit", 100),
      releaseSha256: str(approval.releaseSha256, "approval release hash", 100),
      ...(approval.mode != null ? { mode: (() => {
        if (approval.mode !== "vendor-test" && approval.mode !== "independent-review") throw new Error("Invalid deployment review mode.");
        if (approval.mode === "independent-review" && approval.independentReview === false) throw new Error("Conflicting deployment review mode.");
        return approval.mode;
      })() } : {}),
    },
    runtime: {
      checkedAt: str(runtime.checkedAt, "runtime time", 100),
      functionalProbe: str(runtime.functionalProbe, "functional probe", 50),
      podCount,
      readyCount,
      meshSidecarCount,
      mTLS: str(runtime.mTLS, "mTLS observation", 200),
    },
    checks: checksOf(event.checks),
    families: familiesOf(event.families),
    findingCount: count(event.findingCount, "finding count"),
    gaps: sentences(event.gaps, "evidence gaps"),
  };
  if (evidence.approval.commitSha !== evidence.commitSha || evidence.approval.releaseSha256 !== evidence.releaseSha256) {
    throw new Error("Approval does not match the release subject.");
  }
  if (event.artifacts != null) {
    evidence.artifacts = [...new Set(names(event.artifacts, "artifact inventory"))];
  }
  if (event.reviewItems != null) evidence.reviewItems = parseReviewObservations(event.reviewItems, pipelineArtifactNames(evidence));
  if (event.verification != null) evidence.verification = parsePipelineVerification(event.verification, evidence);
  return evidence;
}

/** Re-validate a stored release. Corrupt files stay off the release screen. */
export function parseStoredPipelineEvidence(input: unknown): LegacyPipelineEvidence {
  const record = object(input, "stored release");
  if (record.source !== "Inbound pipeline event" || record.schema !== "ccm.application-evidence.v1") {
    throw new Error("Stored release is not an inbound pipeline event.");
  }
  const approval = object(record.approval, "approval");
  const runtime = object(record.runtime, "runtime");
  return normalizePipelineEvent({
    schema: PIPELINE_EVENT_SCHEMA,
    systemName: record.systemName,
    pipeline: { id: record.pipelineId, url: record.pipelineUrl, commit: record.commitSha, createdAt: record.createdAt },
    image: record.image,
    releaseSha256: record.releaseSha256,
    policyVerdict: record.policyVerdict,
    signatureStatus: record.signatureStatus,
    signatureScope: record.signatureScope,
    deploymentVerdict: record.deploymentVerdict,
    approval: {
      actor: approval.actor,
      approvedAt: approval.approvedAt,
      commit: approval.commitSha,
      releaseSha256: approval.releaseSha256,
      mode: approval.mode,
    },
    runtime: {
      checkedAt: runtime.checkedAt,
      functionalProbe: runtime.functionalProbe,
      podCount: runtime.podCount,
      readyCount: runtime.readyCount,
      meshSidecarCount: runtime.meshSidecarCount,
      mTLS: runtime.mTLS,
    },
    checks: record.checks,
    families: record.families,
    findingCount: record.findingCount,
    gaps: record.gaps,
    artifacts: record.artifacts,
    artifactRef: typeof record.artifactJobId === "string" && record.artifactJobId ? record.artifactJobId : undefined,
    verification: record.verification,
    reviewItems: record.reviewItems,
  });
}
