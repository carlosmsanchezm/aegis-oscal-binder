/** Short commit shown in the footer. `unknown` when the build has no git SHA. */
export function shortCommit(sha: string | null | undefined): string {
  const value = (sha ?? "").trim();
  return /^[0-9a-f]{7,40}$/i.test(value) ? value.slice(0, 7).toLowerCase() : "unknown";
}

/**
 * Footer SHA. The injected build commit is the source of truth. `VERCEL_GIT_COMMIT_SHA`
 * is only a secondary source so a Vercel build with no extra env var still
 * shows the same seven characters. Unset both renders `unknown`.
 */
export function commitLabel(): string {
  const configured = process.env.AEGIS_COMMIT?.trim();
  const hosted = process.env.VERCEL_GIT_COMMIT_SHA?.trim();
  return shortCommit(process.env.AEGIS_BUILD_COMMIT || configured || hosted);
}
