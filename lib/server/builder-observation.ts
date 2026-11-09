import { personSource, type ItemSource } from "../aegis/item-source";
import { readCollectedArtifact } from "../collector/read";
import type { EvidenceBundle } from "../builder/evidence";
import type { ConnectedHistory } from "../aegis/connected-evidence";

/** Interpret this collector's typed authorization result, never negate arbitrary requirement prose. */
function authorizationResults(bundle: EvidenceBundle): Record<string, string> {
  const results: Record<string, string> = {};
  const event = bundle.event;
  const subject = /^system:serviceaccount:([^:]+):([^:]+)$/.exec(
    event.subject.id,
  );
  if (event.subject.kind !== "identity" || !subject) return results;
  for (const check of event.checks) {
    if (
      check.id !== "frontend-secret-read" ||
      check.version !== "1.0.0" ||
      !check.artifacts.includes("authorization-review.json")
    )
      continue;
    const artifact = event.artifacts.find(
      (a) => a.name === "authorization-review.json",
    );
    if (!artifact) continue;
    try {
      const review = JSON.parse(
        Buffer.from(artifact.contentBase64, "base64").toString("utf8"),
      );
      const attributes = review.spec?.resourceAttributes;
      if (
        review.apiVersion !== "authorization.k8s.io/v1" ||
        review.kind !== "SelfSubjectAccessReview" ||
        attributes?.namespace !== subject[1] ||
        attributes.verb !== "get" ||
        attributes.resource !== "secrets" ||
        attributes.group ||
        attributes.subresource ||
        attributes.name ||
        review.status?.evaluationError ||
        typeof review.status?.allowed !== "boolean"
      )
        continue;
      if (check.verdict !== (review.status.allowed ? "fail" : "pass")) continue;
      results[check.id] =
        `${event.subject.id} ${review.status.allowed ? "was authorized to get" : "was denied get access to"} Kubernetes Secrets in namespace ${subject[1]}.`;
    } catch {
      /* Unrecognized evidence stays a declared failed check, without an invented finding. */
    }
  }
  return results;
}

/** Bundle bytes/digests are verified by the store before this read-only view is constructed. */
export function summarizeBuilderBundle(
  bundle: EvidenceBundle,
): ConnectedHistory {
  return {
    id: bundle.id,
    receivedAt: bundle.receivedAt,
    authentication: bundle.authentication,
    subject: bundle.event.subject,
    run: bundle.event.run,
    checks: bundle.event.checks,
    limitations: bundle.event.limitations,
    artifacts: bundle.event.artifacts.map((a) => ({
      name: a.name,
      sha256: a.sha256,
      source_label: personSource(),
    })),
    observedResults: authorizationResults(bundle),
    collectedArtifacts: bundle.event.artifacts.flatMap((a) => {
      if (a.mediaType !== "application/json") return [];
      let value: unknown;
      try {
        value = JSON.parse(
          Buffer.from(a.contentBase64, "base64").toString("utf8"),
        );
      } catch {
        return [];
      }
      const collected = readCollectedArtifact(value);
      return collected ? [collected] : [];
    }),
  };
}

export function sourcedBuilderBundle(
  bundle: EvidenceBundle,
  sourceLabel: ItemSource,
): ConnectedHistory {
  const summary = summarizeBuilderBundle(bundle);
  return {
    ...summary,
    artifacts: summary.artifacts.map((a) => ({
      ...a,
      source_label: sourceLabel,
    })),
  };
}
