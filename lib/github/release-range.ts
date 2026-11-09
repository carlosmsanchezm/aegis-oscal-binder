import type { Octokit } from "@octokit/rest";

export const MAX_RELEASE_COMMITS = 1000;
/** Explicit pagination avoids GitHub's default 250-commit truncation. No graph walk. */
export async function releaseRange(client: Octokit, owner: string, repo: string, previous: string, current: string, candidates: string[]) {
  if (![current, ...(previous ? [previous] : []), ...candidates].every(sha => /^[a-f0-9]{40}$/.test(sha)))
    throw new Error("Release range requires full commit identities.");
  if (candidates.length > 100) throw new Error("Release candidate limit exceeded.");
  if (!previous) {
    const included = new Set<string>();
    for (const candidate of new Set(candidates)) {
      const {data} = await client.rest.repos.compareCommitsWithBasehead({owner, repo, basehead: candidate + "..." + current, per_page: 1, page: 1});
      if (!Number.isSafeInteger(data.total_commits) || data.total_commits < 0 || data.total_commits > MAX_RELEASE_COMMITS)
        throw new Error("First-release comparison exceeds the bounded range.");
      if (data.status === "ahead" || data.status === "identical") included.add(candidate);
    }
    return included;
  }
  if (previous === current) return new Set<string>();
  const commits = new Set<string>();
  let total: number | undefined;
  for (let page = 1; page <= 10; page++) {
    const {data} = await client.rest.repos.compareCommitsWithBasehead({owner, repo, basehead: previous + "..." + current, per_page: 100, page});
    if (data.status !== "ahead" || !Number.isSafeInteger(data.total_commits) || data.total_commits < 0 || data.total_commits > MAX_RELEASE_COMMITS ||
      (total !== undefined && total !== data.total_commits))
      throw new Error("Release range is divergent, changed or exceeds the bounded range.");
    total = data.total_commits;
    for (const commit of data.commits) {
      if (!/^[a-f0-9]{40}$/.test(commit.sha) || commits.has(commit.sha)) throw new Error("Incomplete release range.");
      commits.add(commit.sha);
    }
    if (commits.size === total) {
      if (!commits.has(current)) throw new Error("Release range does not reach the shipped commit.");
      return commits;
    }
    if (data.commits.length !== 100) break;
  }
  throw new Error("Complete release range unavailable.");
}
