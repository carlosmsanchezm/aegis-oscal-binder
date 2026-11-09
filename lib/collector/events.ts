import {digest} from "./collect";
import type {CollectedArtifact} from "./types";
import {parseEvidenceEvent, type EvidenceEvent} from "../builder/evidence";
import {PROWLER_VERSION} from "./aws/account";

/** Bounded chunks use the same import/CI contract as any connected producer. */
export function collectorEvents(artifacts: CollectedArtifact[], options: {snapshotDigest?: string} = {}) {
  // Derived snapshots can evolve at one pinned revision/time. Their immutable
  // content identity must distinguish them without changing authoritative run ids.
  if (options.snapshotDigest !== undefined && !/^[a-f0-9]{64}$/.test(options.snapshotDigest)) throw new Error("Invalid collector snapshot digest.");
  const output: {id: string; rawEvent: string}[] = [];
  const groups = new Map<string, CollectedArtifact[]>();
  for (const artifact of artifacts) {
    const key = artifact.source.kind === "aws-account"
      ? JSON.stringify(["aws-account", artifact.source.partition, artifact.source.account, artifact.source.region, artifact.capturedAt])
      : JSON.stringify([artifact.source.repo, artifact.source.commit, artifact.capturedAt]);
    groups.set(key, [...(groups.get(key) ?? []), artifact]);
  }
  for (const group of groups.values()) for (let start = 0; start < group.length; start += 20) {
    const batch = group.slice(start, start + 20), first = batch[0];
    const event: EvidenceEvent = first.source.kind === "aws-account"
      ? awsEvent(batch, first, start)
      : gitEvent(batch, first, start);
    if (options.snapshotDigest) event.run.id += "-" + options.snapshotDigest;
    const rawEvent = JSON.stringify(parseEvidenceEvent(event));
    if (Buffer.byteLength(rawEvent) > 512_000) throw new Error("Collector chunk exceeds the import limit.");
    output.push({id: digest(rawEvent), rawEvent});
  }
  return output;
}

function gitEvent(batch: CollectedArtifact[], first: CollectedArtifact, start: number): EvidenceEvent {
  if (first.source.kind === "aws-account") throw new Error("Expected a git source.");
  return {
    schema: "aegis.evidence-event.v1", run: {id: `source-${first.source.commit.slice(0,12)}-${start}`, producer: "Aegis source collector v1", observedAt: first.capturedAt},
    subject: {kind: "code", id: first.source.repo, revision: first.source.commit},
    checks: [{id: "source-inventory", version: "1", description: "Pinned source facts; security effectiveness not assessed", requirement: {framework: "Evidence inventory", reference: "source-facts", objective: "Retain safe extracted facts for a person's applicability review."}, verdict: "unknown", artifacts: batch.map(a => a.name), validUntil: new Date(Date.parse(first.capturedAt) + 86400_000).toISOString()}],
    artifacts: batch.map(a => {const content = JSON.stringify(a); return {name: a.name, mediaType: "application/json", contentBase64: Buffer.from(content).toString("base64"), sha256: digest(content)};}),
    limitations: ["Pinned source capture; no live deployment or executed pipeline test is asserted.", "Agent mapping proposals remain unaccepted; digests do not authenticate a producer.", "Raw files and secret values are excluded."],
  };
}

function awsEvent(batch: CollectedArtifact[], first: CollectedArtifact, start: number): EvidenceEvent {
  if (first.source.kind !== "aws-account") throw new Error("Expected an aws-account source.");
  const source = first.source;
  return {
    schema: "aegis.evidence-event.v1",
    run: {id: `aws-${source.account}-${source.region}-${start}`, producer: "Aegis source collector v1", observedAt: first.capturedAt},
    subject: {kind: "infrastructure", id: `${source.partition}:${source.account}:${source.region}`, revision: PROWLER_VERSION},
    checks: [{id: "source-inventory", version: "1", description: `Pinned ${source.partition} account facts from Prowler. Coverage only. Not an authorization result.`, requirement: {framework: "Evidence inventory", reference: "aws-account", objective: "Retain safe extracted account facts for a person's applicability review."}, verdict: "unknown", artifacts: batch.map(a => a.name), validUntil: new Date(Date.parse(first.capturedAt) + 86400_000).toISOString()}],
    artifacts: batch.map(a => {const content = JSON.stringify(a); return {name: a.name, mediaType: "application/json", contentBase64: Buffer.from(content).toString("base64"), sha256: digest(content)};}),
    limitations: [
      "Pinned Prowler output. No authorization or control satisfaction is asserted.",
      ...new Set(batch.flatMap(a=>a.limitations.filter(l=>l.includes("SYNTHETIC FIXTURE")))),
      "Agent mapping proposals remain unaccepted. Digests do not authenticate a producer.",
      "Raw cloud responses and secret values are excluded.",
      `Read-only ${source.partition} account ${source.account}. This collector does not call AWS write APIs.`,
    ],
  };
}
