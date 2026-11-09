import {readCollectedArtifact} from "../collector/read";
import type {CollectedArtifact} from "../collector/types";
import { parseReviewObservations, type ReviewObservation } from "./review-context";
import type { PipelineVerification } from "./pipeline-verification";
/** A read-only, assessment-supporting view of a CI release summary. Never an SSP or ATO result. */
export type PipelineCheck = { id: string; status: string; findings: number | null; blockingCount: number | null; artifact: string; reportedVerdict?: "pass" | "fail" | "unknown"; validUntil?: string };
/** Measured retest observations for one control. These are not pipeline scanner ids and they are not a control pass. */
export type RecordedCheck = { control: string; description: string; result: string; date: string; reviewer: string; artifact: string };
export type PipelineFamily = { family: string; controls: string[]; coverage: string; evidence: string[] };
export type LegacyPipelineEvidence = {
  schema: "ccm.application-evidence.v1";
  source: "CCM release summary" | "Inbound pipeline event";
  systemName?: string;
  pipelineId: string;
  pipelineUrl: string;
  artifactJobId: string;
  commitSha: string;
  image: string;
  createdAt: string;
  releaseSha256: string;
  policyVerdict: string;
  signatureStatus: string;
  signatureScope: string;
  deploymentVerdict: string;
  approval: { actor: string; approvedAt: string; commitSha: string; releaseSha256: string; mode?: "independent-review" | "vendor-test" };
  runtime: { checkedAt: string; functionalProbe: string; podCount: number; readyCount: number; meshSidecarCount: number; mTLS: string };
  checks: PipelineCheck[];
  families: PipelineFamily[];
  findingCount: number;
  gaps: string[];
  artifacts?: string[];
  collectedArtifacts?: CollectedArtifact[];
  sourceInventoryHref?: string;
  reviewItems?: ReviewObservation[];
  verification?: PipelineVerification;
  recordedChecks?: RecordedCheck[];
};

/** Observations use the existing evidence workflow without fabricated deployment fields. */
export type SystemObservationEvidence = Omit<LegacyPipelineEvidence, "schema" | "source" | "image" | "approval" | "runtime"> & {
  releaseEvidence?: import("./release-evidence").ReleaseEvidence;
  schema: "aegis.evidence-event.v1";
  source: "Retained system observation";
  image: null; approval: null; runtime: null;
  observation: {
    connectionId: string; systemName: string; subject: import("../builder/evidence").EvidenceEvent["subject"];
    producer: string; checks: import("../builder/evidence").EvidenceEvent["checks"];
    artifactDigests: { name: string; sha256: string }[];
    reportedOutcome: "pass" | "fail" | "unknown";
  };
};
export type PipelineEvidence = LegacyPipelineEvidence | SystemObservationEvidence;

const PROJECT = "https://gitlab.com/enbuild-staging/enbuild-deployments/podinfo-gsa-evidence-0928";
const PIPELINE_ID = "2894050908";
const JOB_ID = "16815627409";

// Curated, non-secret fields from the vendor-owned CCM summary downloaded 30 Sep 2026.
// This is a dated snapshot with links back to the producing job, never a live connector.
export const CCM_EXAMPLE: LegacyPipelineEvidence = {
  schema: "ccm.application-evidence.v1", source: "CCM release summary",
  systemName: "Podinfo",
  pipelineId: PIPELINE_ID, pipelineUrl: `${PROJECT}/-/pipelines/${PIPELINE_ID}`, artifactJobId: JOB_ID,
  commitSha: "f6ffa86f957e93012a7bea69b51152407d4ce01b",
  image: "registry.gitlab.com/enbuild-staging/enbuild-deployments/podinfo-gsa-evidence-0928/application@sha256:c1f1413505f18b9be7d88044dbc85c90a2eaad9a56a48ca1f392161e1dbec8e6",
  createdAt: "2026-09-29T15:56:36.331973+00:00", releaseSha256: "e3496e3012df6d8949ea0cdc1fc3b0c912381152028105f254c21ef361792ece",
  policyVerdict: "pass", signatureStatus: "verified", signatureScope: "GitLab OIDC signed evidence package; original image publisher verification is a separate check",
  deploymentVerdict: "observed",
  approval: { actor: "junaid18183", approvedAt: "2026-09-29T17:18:29.782529+00:00", commitSha: "f6ffa86f957e93012a7bea69b51152407d4ce01b", releaseSha256: "e3496e3012df6d8949ea0cdc1fc3b0c912381152028105f254c21ef361792ece", mode: "independent-review" },
  runtime: { checkedAt: "2026-09-29T17:18:52.024918+00:00", functionalProbe: "pass", podCount: 2, readyCount: 2, meshSidecarCount: 0, mTLS: "not established by sidecar presence" },
  checks: [
    { id: "sast", status: "pass", findings: 30, blockingCount: 0, artifact: "sast.json" },
    { id: "dependencies", status: "pass", findings: 0, blockingCount: 0, artifact: "dependencies.json" },
    { id: "image", status: "pass", findings: 0, blockingCount: 0, artifact: "image.json" },
    { id: "configuration", status: "pass", findings: 3, blockingCount: 0, artifact: "configuration.json" },
    { id: "secrets", status: "pass", findings: 0, blockingCount: 0, artifact: "secrets.json" },
    { id: "publisher-signature", status: "pass", findings: 0, blockingCount: 0, artifact: "publisher-signature.json" },
    { id: "built-image-signature", status: "pass", findings: 0, blockingCount: 0, artifact: "built-image-signature.json" },
    { id: "sbom", status: "pass", findings: null, blockingCount: null, artifact: "sbom.cdx.json" },
  ],
  families: [
    { family: "SA", controls: ["SA-11"], coverage: "Exact patched source SAST and dependency analysis; selected development-security evidence.", evidence: ["sast", "dependencies"] },
    { family: "RA", controls: ["RA-5"], coverage: "Point-in-time source/image vulnerability results and severity policy; complete risk assessment not performed.", evidence: ["image", "dependencies"] },
    { family: "SI", controls: ["SI-2", "SI-7"], coverage: "Original publisher and rebuilt image signatures, SBOM and source patch; full flaw-remediation program not assessed.", evidence: ["image", "secrets", "sbom.cdx.json", "publisher-signature", "built-image-signature", "build-provenance.json"] },
    { family: "CM", controls: ["CM-3", "CM-6"], coverage: "Exact source, rendered manifests, signed report hashes and independent change-review receipt.", evidence: ["manifests.yaml", "configuration", "subject.json"] },
    { family: "AC", controls: ["AC-5", "AC-6"], coverage: "Different authenticated GitLab user approved the exact release hash and target; runner/AWS least privilege not assessed.", evidence: ["approval.json", "configuration"] },
    { family: "AU", controls: ["AU-3", "AU-9", "AU-12"], coverage: "CI actor, source, pipeline and tamper-evident artifact hashes; seven-day demo retention, no agency audit integration.", evidence: ["subject.json", "release.sigstore.json"] },
    { family: "SC", controls: ["SC-7", "SC-8"], coverage: "Rendered network boundary and container settings; actual network-policy and mTLS enforcement remain unverified.", evidence: ["configuration", "runtime.json"] },
    { family: "CA", controls: ["CA-5", "CA-7"], coverage: "Owned findings and point-in-time checks; agency POA&M entry and continuous-monitoring program remain outside this demo.", evidence: ["findings.json", "runtime.json"] },
  ],
  findingCount: 33,
  reviewItems: [{
    id:"configuration-KSV-0020-0021",
    description:"Configuration scan reports KSV-0020 (UID ≤ 10000) and KSV-0021 (GID ≤ 10000). Review against the workload's approved hardening criteria; scan severity alone is not a POA&M decision.",
    retestPacketUrl:"/samples/remediation/podinfo-identity-retest.json",
    scope:{
      title:"Application UID/GID hardening", asset:"Podinfo application container", controls:["CM-6"], framework:"NIST SP 800-53 Rev 5",
      baseline:"Vendor workload hardening criteria: application UID and primary GID > 10000; selected control context only",
      artifacts:["configuration.json","manifests.yaml"],
      verification:["Configuration rescan no longer reports KSV-0020 or KSV-0021","Actual application process UID and GID match the corrected manifest","Corrected workload remains ready and /healthz succeeds"],
      remainingScope:["Trusted-registry finding","Network enforcement","mTLS"]
    }
  }],
  // Filenames verified in the downloaded artifact directory for this exact release.
  // Inventory is not a claim that each file has a control or statement mapping.
  artifacts: ["approval.json", "build-provenance.json", "built-image-signature.json", "built-image-signature.raw.json", "configuration.json", "configuration.raw.json", "dependencies.json", "dependencies.raw.json", "findings.json", "image.json", "image.raw.json", "image-verification.json", "manifests.yaml", "publisher-manifest.json", "publisher-signature.json", "publisher-signature.raw.json", "release.json", "release.sigstore.json", "runtime.json", "sast.json", "sast.raw.json", "sbom.cdx.json", "secrets.json", "security-patch.diff", "security-patch.json", "subject.json", "summary.json", "summary.sigstore.json"],
  // Independently pinned upstream source facts; not part of the historical pipeline seal.
  sourceInventoryHref: "/api/collector/references/3e0ff8ae123b710bc91de1315cba0f996a8896c2",
  gaps: [
    "Vendor application built from exact upstream source plus sealed security patch; independent reproducibility not verified.",
    "Independent build reproducibility and a SLSA level assessment are not established.",
    "Control mappings support assessment; no complete Low/Moderate/High or FedRAMP authorization is asserted.",
    "Network-policy enforcement, external ingress and mTLS enforcement are not established by manifest scans, sidecar presence or a localhost health probe.",
    "Runner/AWS permission least privilege and agency POA&M integration are not assessed by this package.",
  ],
};

/** Exact, selected control mapping only; family membership alone does not imply coverage. */
export function pipelineMappingForControl(record: PipelineEvidence, controlId: string): PipelineFamily | null {
  return record.families.find((family) => family.controls.includes(controlId)) ?? null;
}

export function artifactFilename(name: string): string {
  return /\.[A-Za-z0-9]+$/.test(name) ? name : `${name}.json`;
}

/** Union of the actual inventory, checks and mappings; unmapped files remain selectable. */
export function pipelineArtifactNames(record: PipelineEvidence): string[] {
  const inventory = record.artifacts ?? (record.pipelineUrl === CCM_EXAMPLE.pipelineUrl && record.commitSha === CCM_EXAMPLE.commitSha ? CCM_EXAMPLE.artifacts! : []);
  return [...new Set([...inventory, ...(record.collectedArtifacts ?? []).map(a => a.name), ...record.checks.map((check) => check.artifact), ...record.families.flatMap((family) => family.evidence)].map(artifactFilename))].sort();
}

/** Only the controls explicitly associated with this artifact; never expand to an entire family. */
export function controlsForArtifact(record: PipelineEvidence, artifact: string): string[] {
  return [...new Set(record.families.filter((family) => family.evidence.some((name) => artifactFilename(name) === artifactFilename(artifact))).flatMap((family) => family.controls))];
}

/** Store only normalized fields, not the original summary's additional account/tenant data. */
export function summaryForSession(record: PipelineEvidence): unknown {
  if (record.schema !== "ccm.application-evidence.v1") throw new Error("System observations retain their original bundle; they are not CCM summaries.");
  return {
    data: {
      ...record,
      subject: { pipelineId: record.pipelineId, pipelineUrl: record.pipelineUrl, commitSha: record.commitSha, image: record.image, createdAt: record.createdAt },
      runtime: { ...record.runtime, observations: Array.from({ length: record.runtime.podCount }, (_, i) => ({ ready: i < record.runtime.readyCount, meshSidecarPresent: i < record.runtime.meshSidecarCount })) },
      controlFamilies: record.families, evidenceGaps: record.gaps,
    },
    provenance: { pipelineId: record.pipelineId, jobId: record.artifactJobId },
  };
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a CCM release-summary object.");
  return value as Record<string, unknown>;
}
function str(value: unknown, label: string, max = 1000): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`Missing or invalid ${label}.`);
  return value;
}
function count(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${label}.`);
  return value;
}
function optionalCount(value: unknown, label: string): number | null { return value == null ? null : count(value, label); }
function names(value: unknown, label: string, max = 120): string[] {
  if (!Array.isArray(value) || value.length > 40) throw new Error(`Invalid ${label}.`);
  return value.map((item) => str(item, label, max));
}

export function gitlabArtifactUrl(evidence: PipelineEvidence, name: string): string | null {
  const file = artifactFilename(name);
  if (!/^[A-Za-z0-9_.-]{1,80}$/.test(file)) return null;
  try {
    const url = new URL(evidence.pipelineUrl);
    if (url.pathname === `/api/builder/evidence/${evidence.releaseSha256}` && /^[a-f0-9]{64}$/.test(evidence.releaseSha256) && /^[a-f0-9-]{36}$/.test(url.searchParams.get("connection") ?? "") && evidence.artifacts?.includes(file)) {
      url.searchParams.set("artifact", file);
      return `${url.pathname}${url.search}`;
    }
  const collected = evidence.collectedArtifacts?.find(a => a.name === file);
  if (collected) {
    if ("url" in collected.source && collected.source.url) return collected.source.url;
    if (collected.source.kind) return `/api/collector/artifacts/${collected.sha256}`;
    const repo = new URL(collected.source.repo);
    if (repo.hostname === "github.com") return `${repo.origin}${repo.pathname}/blob/${collected.source.commit}/${collected.source.path.split("/").map(encodeURIComponent).join("/")}`;
    // Other providers retain metadata without inventing a source browser route.
    return null;
  }
    if (url.origin !== "https://gitlab.com" || !/^\d+$/.test(evidence.artifactJobId)) return null;
    const match = url.pathname.match(/^(\/[^?#]+)\/-\/pipelines\/\d+$/);
    if (!match) return null;
    return `${url.origin}${match[1]}/-/jobs/${evidence.artifactJobId}/artifacts/file/evidence/${file}`;
  } catch { return null; }
}

/** Adapter boundary: future CI systems can emit this normalized shape without changing the viewer. */
export function parseCcmSummary(input: unknown): LegacyPipelineEvidence {
  const wrapper = object(input);
  const data = object(wrapper.data);
  if (data.schema !== "ccm.application-evidence.v1") throw new Error("Unsupported evidence schema. Expected ccm.application-evidence.v1.");
  const subject = object(data.subject), approval = object(data.approval), runtime = object(data.runtime), provenance = object(wrapper.provenance);
  if (approval.mode!=null && !["independent-review","vendor-test"].includes(String(approval.mode))) throw new Error("Unsupported deployment review mode.");
  const pipelineUrl = str(subject.pipelineUrl, "pipeline URL", 500);
  if (!/^https:\/\/gitlab\.com\/[^?#]+\/-\/pipelines\/\d+$/.test(pipelineUrl)) throw new Error("Only a GitLab pipeline URL is accepted by this CCM adapter.");
  const observations = runtime.observations;
  if (!Array.isArray(observations) || observations.length > 500) throw new Error("Invalid runtime observations.");
  const checks = data.checks, families = data.controlFamilies;
  if (!Array.isArray(checks) || checks.length > 50 || !Array.isArray(families) || families.length > 30) throw new Error("Invalid checks or control mappings.");
  const evidence: LegacyPipelineEvidence = {
    schema: "ccm.application-evidence.v1", source: "CCM release summary",
    ...(data.systemName == null ? {} : {systemName:str(data.systemName,"system name",200)}),
    pipelineId: str(subject.pipelineId, "pipeline ID", 30), pipelineUrl, artifactJobId: str(provenance.jobId, "artifact job ID", 30),
    commitSha: str(subject.commitSha, "commit", 100), image: str(subject.image, "image", 500), createdAt: str(subject.createdAt, "creation time", 100),
    releaseSha256: str(data.releaseSha256, "release hash", 100), policyVerdict: str(data.policyVerdict, "policy verdict", 50),
    signatureStatus: str(data.signatureStatus, "signature status", 50), signatureScope: str(data.signatureScope, "signature scope"),
    deploymentVerdict: str(data.deploymentVerdict, "deployment verdict", 50),
    approval: { actor: str(approval.actor, "approval actor", 100), approvedAt: str(approval.approvedAt, "approval time", 100), commitSha: str(approval.commitSha, "approval commit", 100), releaseSha256: str(approval.releaseSha256, "approval release hash", 100), ...(approval.mode!=null?{mode:approval.mode as "independent-review" | "vendor-test"}:{}) },
    runtime: { checkedAt: str(runtime.checkedAt, "runtime time", 100), functionalProbe: str(runtime.functionalProbe, "functional probe", 50), podCount: observations.length,
      readyCount: observations.filter((v) => object(v).ready === true).length, meshSidecarCount: observations.filter((v) => object(v).meshSidecarPresent === true).length,
      mTLS: str(runtime.mTLS, "mTLS observation", 200) },
    checks: checks.map((v) => { const c = object(v); return { id: str(c.id, "check ID", 80), status: str(c.status, "check status", 50), findings: optionalCount(c.findings, "findings"), blockingCount: optionalCount(c.blockingCount, "blocking count"), artifact: str(c.artifact, "check artifact", 80) }; }),
    families: families.map((v) => { const f = object(v); return { family: str(f.family, "family", 10), controls: names(f.controls, "controls"), coverage: str(f.coverage, "coverage"), evidence: names(f.evidence, "evidence") }; }),
    findingCount: count(data.findingCount, "finding count"), gaps: names(data.evidenceGaps, "evidence gaps", 1000),
  };
  if (data.artifacts != null || data.runtimeArtifacts != null) {
    const inventory = [...new Set([data.artifacts, data.runtimeArtifacts].filter((value) => value != null).flatMap((value) => Array.isArray(value) ? names(value, "artifact inventory", 80) : Object.keys(object(value))))];
    if (inventory.length > 40 || inventory.some((name) => !gitlabArtifactUrl(evidence, name))) throw new Error("Invalid artifact inventory.");
    evidence.artifacts = [...new Set(inventory.map(artifactFilename))];
  }
  if (data.sourceInventoryHref != null) {
    if (typeof data.sourceInventoryHref !== "string" || !/^\/api\/collector\/references\/[a-f0-9]{40}$/.test(data.sourceInventoryHref)) throw new Error("Invalid source inventory reference.");
    evidence.sourceInventoryHref = data.sourceInventoryHref;
  }
  if (data.collectedArtifacts != null) {
    if (!Array.isArray(data.collectedArtifacts) || data.collectedArtifacts.length > 1000) throw new Error("Invalid source inventory.");
    evidence.collectedArtifacts = data.collectedArtifacts.map(value => {const a = readCollectedArtifact(value); if (!a) throw new Error("Invalid source artifact."); return a;});
  }
  if (data.reviewItems != null) {
    evidence.reviewItems = parseReviewObservations(data.reviewItems, pipelineArtifactNames(evidence));
    if (evidence.reviewItems.some(item => item.scope.artifacts.some(name => !gitlabArtifactUrl(evidence, name)))) throw new Error("Invalid review artifact.");
  }
  if (evidence.approval.commitSha !== evidence.commitSha || evidence.approval.releaseSha256 !== evidence.releaseSha256) throw new Error("Approval does not match the release subject.");
  if (provenance.pipelineId !== evidence.pipelineId || !gitlabArtifactUrl(evidence, "summary.json")) throw new Error("Pipeline and artifact provenance do not match.");
  return evidence;
}
