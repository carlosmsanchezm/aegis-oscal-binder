/** Server-owned projection on the existing connection-bound remediation record. */
export type PullRequestLink = {
  schema: "binder.pull-request-link.v1";
  emergency?: boolean;
  poamItemId: string;
  findingId: string;
  sourceReleaseId: string;
  draftRevision?: string;
  connectionId: string;
  installationId: number;
  owner: string;
  repo: string;
  prNumber: number;
  prUrl: string;
  headSha: string;
  baseSha: string;
  state: "open" | "merged" | "closed";
  mergedCommitSha?: string;
  ciStatus: { sha: string; state: "pending" | "success" | "failure"; checkedAt: string; checks: number; runs?: { id: string; url: string }[] };
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};
export function ciGreenFor(link: PullRequestLink, sha: string, now = Date.now()) {
  return link.ciStatus.sha === sha && link.ciStatus.state === "success" && link.ciStatus.checks > 0 &&
    Date.parse(link.ciStatus.checkedAt) <= now + 300_000 && now - Date.parse(link.ciStatus.checkedAt) < 3600_000;
}
