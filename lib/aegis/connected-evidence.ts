import type { CollectedArtifact } from "../collector/types";
import { deriveReviewItems } from "../collector/derive-review-items";
import { collectedFindings } from "../collector/mappings";
import { AWS_DEPLOYMENT_PRODUCER } from "../collector/aws/deployment-criteria";
import { checkState, type EvidenceEvent } from "../builder/evidence";
import type { SystemObservationEvidence } from "./pipeline-evidence";

export type ConnectedHistory = {
  id: string;
  receivedAt: string;
  authentication?: "connection-token" | "browser-owner";
  subject: EvidenceEvent["subject"];
  run: EvidenceEvent["run"];
  checks: EvidenceEvent["checks"];
  limitations: string[];
  artifacts: {
    name: string;
    sha256: string;
    source_label?: import("./item-source").ItemSource;
  }[];
  collectedArtifacts?: CollectedArtifact[];
  observedResults?: Record<string, string>;
};
export type EvidenceConnection = {
  fixProgress?: import("./fix-progress").FixProgress | null;
  releaseEvidence?: import("./release-evidence").ReleaseEvidence[];
  id: string;
  name: string;
  createdAt: string;
  revokedAt: string | null;
  history: ConnectedHistory[];
};

/** A framework label alone cannot turn a customer's policy into NIST coverage. */
export function observationControl(
  check: EvidenceEvent["checks"][number],
): string | null {
  const reference = check.requirement.reference.trim().toUpperCase();
  if (
    check.requirement.framework === "NIST SP 800-53 Rev 5" &&
    /^[A-Z]{2}-\d+(?:\.\d+)?$/.test(reference)
  )
    return reference;
  if (
    check.requirement.framework === "FedRAMP 20x" &&
    /^KSI(?:-[A-Z0-9]+)+$/.test(reference)
  )
    return reference;
  return null;
}

/** Retained, verified manifests enter the same map and proposal engine as pipeline evidence. */
export function connectedReleases(
  connection: EvidenceConnection,
  origin: string,
  now = Date.now(),
): SystemObservationEvidence[] {
  return connection.history
    .map((h): SystemObservationEvidence => {
      const url = new URL(`/api/builder/evidence/${h.id}`, origin);
      url.searchParams.set("connection", connection.id);
      const states = h.checks.map((c) => checkState({ run: h.run }, c, now));
      const scanner =
        (h.run.producer === AWS_DEPLOYMENT_PRODUCER || (h.run.producer === "GitHub Actions" &&
        h.collectedArtifacts?.some((a) =>
          a.facts.some((f) => f.key === "scan-findings"),
        )));
      const scannerCount = (
        c: (typeof h.checks)[number],
        key: string,
      ): number | null => {
        if (h.run.producer===AWS_DEPLOYMENT_PRODUCER) return key==="scan-findings"
          ? (h.collectedArtifacts??[]).flatMap(a=>a.facts).filter(f=>f.field===c.id&&f.value==="fail").length : null;
        const fact = h.collectedArtifacts
          ?.find((a) => c.artifacts.includes(a.name))
          ?.facts.find((f) => f.key === key);
        return typeof fact?.value === "number" ? fact.value : null;
      };
      return {
        schema: "aegis.evidence-event.v1",
        source: "Retained system observation",
        pipelineId: h.id.slice(0, 32),
        pipelineUrl: url.toString(),
        artifactJobId: h.run.id,
        commitSha: h.subject.revision,
        createdAt: h.run.observedAt,
        releaseSha256: h.id,
        releaseEvidence: connection.releaseEvidence?.find(bundle => bundle.releaseSha256 === h.id),
        image: null,
        approval: null,
        runtime: null,
        policyVerdict: states.includes("fail")
          ? "fail"
          : states.every((s) => s === "pass")
            ? "pass"
            : "unknown",
        signatureStatus: "Artifact digests checked",
        signatureScope:
          h.authentication === "browser-owner"
            ? "Imported by the owning browser session; producer identity unverified."
            : "Connection credential authenticated; producer identity unverified.",
        deploymentVerdict: "Not assessed",
        observation: {
          connectionId: connection.id,
          systemName: connection.name,
          subject: h.subject,
          producer: h.run.producer,
          checks: h.checks,
          artifactDigests: h.artifacts,
          reportedOutcome: h.checks.some((c) => c.verdict === "fail")
            ? "fail"
            : h.checks.every((c) => c.verdict === "pass")
              ? "pass"
              : "unknown",
        },
        checks: h.checks.map((c, index) => ({
          id: c.id,
          status: states[index],
          reportedVerdict: c.verdict,
          validUntil: c.validUntil,
          findings:
            scanner && c.verdict !== "unknown"
              ? scannerCount(c, "scan-findings")
              : c.verdict === "fail"
                ? 1
                : null,
          blockingCount: scanner ? scannerCount(c, "scan-blocking") : null,
          artifact: c.artifacts[0],
        })),
        families: h.checks.flatMap((c, index) => {
          const control = observationControl(c);
          return control
            ? [
                {
                  family: control.split("-")[0],
                  controls: [control],
                  coverage: `${c.requirement.objective} · ${states[index]} observation; selected objective only.`,
                  evidence: c.artifacts,
                },
              ]
            : [];
        }),
        findingCount: scanner
          ? h.checks.reduce(
              (n, c) => n + (scannerCount(c, "scan-findings") ?? 0),
              0,
            )
          : h.checks.filter((c) => c.verdict === "fail").length,
        artifacts: h.artifacts.map((a) => a.name),
        collectedArtifacts: h.collectedArtifacts,
        reviewItems: scanner
          ? deriveReviewItems(h.collectedArtifacts ?? [])
          : [
              ...collectedFindings(h.collectedArtifacts ?? []),
              ...h.checks.flatMap((c, index) => {
                const control = observationControl(c);
                return c.verdict === "fail" && control
                  ? [
                      {
                        id: `check-${index}`,
                        description: h.observedResults?.[c.id]
                          ? `Observed failure: ${h.observedResults[c.id]}`
                          : `Check reported FAIL: ${c.id}. Required outcome (not met): ${c.requirement.objective}`,
                        scope: {
                          title: `Failed check: ${c.id}`,
                          asset: h.subject.id,
                          controls: [control],
                          framework: c.requirement.framework,
                          baseline:
                            "Producer-declared mapping; selected objective requires applicability review.",
                          artifacts: c.artifacts,
                          verification: [c.requirement.objective],
                          remainingScope: h.limitations,
                        },
                      },
                    ]
                  : [];
              }),
            ],
        gaps: [
          ...h.limitations,
          ...h.checks
            .filter((c) => !observationControl(c))
            .map(
              (c) =>
                `${c.requirement.framework} · ${c.requirement.reference}: retained for review; no NIST mapping inferred.`,
            ),
        ],
      };
    })
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}
