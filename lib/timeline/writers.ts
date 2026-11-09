import { factCandidates } from "../collector/mappings";
import { moderateControls } from "../aegis/moderate-baseline";
import { appendTimeline } from "./store";
import { summarizeBuilderBundle } from "../server/builder-observation";
import { connectedReleases } from "../aegis/connected-evidence";
import { scannerRetestDiff } from "../collector/retest-diff";
import type { EvidenceBundle } from "../builder/evidence";
import type { CollectedArtifact } from "../collector/types";
export async function recordBundleTimeline(
  bundle: EvidenceBundle,
  collected = false,
  root?: string,
) {
  const { readConnection, listBundles } = await import(
    "../server/builder-store"
  );
  const c = await readConnection(bundle.connectionId, root);
  if (!c) throw new Error("Timeline connection unavailable.");
  const all = connectedReleases(
    {
      ...c,
      revokedAt: c.revokedAt ?? null,
      history: (await listBundles(c.id, root)).map(summarizeBuilderBundle),
    },
    "http://localhost",
  );
  const current = all.find((r) => r.releaseSha256 === bundle.id)!;
  const previous = [...all]
    .reverse()
    .find(
      (r) =>
        scannerRetestDiff(r, current, Date.parse(current.createdAt) + 1)
          .comparable,
    );
  const diff = previous
    ? scannerRetestDiff(previous, current, Date.parse(current.createdAt) + 1)
    : null;
  const issues = current.reviewItems ?? [],
    removed = diff?.fixed ?? [];
  const artifacts = current.collectedArtifacts ?? [];
  const aws = artifacts.find((a) => a.source.kind === "aws-account");
  const allowed = new Set(moderateControls().map((c) => c.id));
  const controls = [
    ...new Set([
      ...issues.flatMap((i) => i.scope.controls),
      ...(previous?.reviewItems
        ?.filter((i) => removed.includes(i.id))
        .flatMap((i) => i.scope.controls) ?? []),
      ...artifacts.flatMap((a) =>
        factCandidates(a, allowed, "fedramp-rev5").map((m) => m.controlId),
      ),
    ]),
  ];
  const counts = Object.fromEntries(
    bundle.event.checks.flatMap((check) => {
      const count = artifacts
        .find((a) => check.artifacts.includes(a.name))
        ?.facts.find((f) => f.key === "scan-findings")?.value;
      return typeof count === "number" ? [[check.id + "Findings", count]] : [];
    }),
  );
  return appendTimeline(
    c.id,
    {
      id:
        bundle.event.subject.id +
        ":" +
        bundle.event.run.producer +
        ":" +
        bundle.event.run.id +
        (bundle.event.run.producer === "GitHub Actions"
          ? ""
          : ":" + bundle.event.run.observedAt),
      kind: aws
        ? "govcloud-reader"
        : bundle.event.run.producer !== "GitHub Actions"
          ? "monitoring-capture"
          : previous
            ? "retest"
            : "github-actions-run",
      source:
        aws && aws.source.kind === "aws-account"
          ? { accountId: aws.source.account, runId: bundle.event.run.id }
          : {
              ...(bundle.event.subject.kind === "code" ? {repo: bundle.event.subject.id} : {}),
              runId: bundle.event.run.id,
              ...(bundle.event.run.url ? { url: bundle.event.run.url } : {}),
            },
      commit: bundle.event.subject.revision,
      observedAt: bundle.event.run.observedAt,
      artifactSha256: bundle.event.artifacts.map((a) => a.sha256),
      controls,
      findings: [...new Set([...issues.map((i) => i.id), ...removed])],
      collected,
      summary: {
        ...counts,
        removedFindings: removed,
        removedRules:
          previous?.reviewItems
            ?.filter((i) => removed.includes(i.id))
            .map((i) => i.scope.title) ?? [],
      },
    },
    root,
  );
}
export async function recordCaptureTimeline(
  connectionId: string,
  input: {
    id: string;
    commit: string;
    repo: string;
    observedAt: string;
    artifacts: CollectedArtifact[];
    controls: string[];
    regressions: number;
  },
  root?: string,
) {
  return appendTimeline(
    connectionId,
    {
      id: "capture:" + input.id,
      kind: "monitoring-capture",
      source: { repo: input.repo },
      commit: input.commit,
      observedAt: input.observedAt,
      artifactSha256: input.artifacts.map((a) => a.sha256),
      controls: input.controls,
      findings: [],
      collected: true,
      summary: { regressions: input.regressions },
    },
    root,
  );
}
