import type { PullRequestLink } from "../github/pr-types";

/** Server projection of existing PR links and trusted collector receipts, never an approval. */
export type ReleaseItem = {
  poamItemId: string;
  findingId: string;
  sourceReleaseId: string;
  controlId: string;
  prNumber: number;
  prUrl: string;
  mergeSha: string;
  ciRunId: string;
  ciRunUrl: string;
  ciRuns: { id: string; url: string }[];
  retestResult: "pass" | "remaining" | "unverified";
  retestReceiptId?: string;
  carriedForward?: boolean;
};
export type ReleaseEvidence = {
  schema: "binder.release-evidence.v1";
  connectionId: string;
  repository: string;
  releaseId: string;
  releaseSha256: string;
  commitSha: string;
  previousCommitSha: string;
  tagOrDeploy: string;
  collectedAt: string;
  releaseUrl: string;
  rangeStatus: "verified" | "unverified";
  rangeProblem?: string;
  remainingControls?: string[];
  items: ReleaseItem[];
};
export function activePrLinks(links: PullRequestLink[]) {
  return [...new Map(links.map(link => [link.poamItemId, link])).values()];
}
export function releaseEvidenceHref(bundle: ReleaseEvidence) {
  return "/planning?view=release&connection=" + encodeURIComponent(bundle.connectionId) + "&release=" + encodeURIComponent(bundle.releaseId);
}
/** Every retained item on a control must pass before the release-fix treatment. */
export function releaseFixedControls(bundle?: ReleaseEvidence) {
  if (bundle?.rangeStatus !== "verified") return new Set<string>();
  return new Set(bundle.items.filter(item => item.retestResult === "pass" && !bundle.remainingControls?.includes(item.controlId) &&
    bundle.items.filter(other => other.controlId === item.controlId).every(other => other.retestResult === "pass"))
    .map(item => item.controlId));
}
