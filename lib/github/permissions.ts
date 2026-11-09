import { GithubPermissionError } from "./config";

/** Scopes this scanner is willing to hold. Source scans do not request Actions access. Release intake requests Actions read only. */
export const READ_ONLY_SCOPES = ["actions", "contents", "metadata", "pull_requests", "checks"] as const;

/** Token scopes for one pinned scan. Actions is intentionally absent. */
export const SCAN_PERMISSIONS = { contents: "read", metadata: "read" } as const;

/** Token scopes for listing installation repositories. Contents is not requested. */
export const LIST_PERMISSIONS = { metadata: "read" } as const;

const ALLOWED = new Set<string>(READ_ONLY_SCOPES);

export function assertReadOnlyPermissions(permissions: Record<string, string> | null | undefined, required: readonly string[]): void {
  const entries = Object.entries(permissions ?? {});
  if (!entries.length) throw new GithubPermissionError("GitHub did not grant read permissions.");
  for (const [name, value] of entries) {
    if (!ALLOWED.has(name) || value !== "read") throw new GithubPermissionError(`GitHub permission ${name} is not a read-only scope.`);
  }
  for (const name of required) {
    if (permissions?.[name] !== "read") throw new GithubPermissionError(`GitHub permission ${name} read was not granted.`);
  }
}

/** Repository-scoped release intake never requests write permissions. */
export const RELEASE_PERMISSIONS = { actions: "read", contents: "read", metadata: "read" } as const;

/** Narrow capabilities; source/release tokens remain strictly read only. */
export const PR_READ_PERMISSIONS = { metadata: "read", contents: "read", pull_requests: "read", checks: "read" } as const;
// GitHub must resolve private head/base refs while creating the PR. This is
// contents read only; branch pushes and merging remain outside this capability.
export const PR_OPEN_PERMISSIONS = { metadata: "read", contents: "read", pull_requests: "write" } as const;
export const GATE_PERMISSIONS = { metadata: "read", pull_requests: "read", checks: "write" } as const;
export function assertCapabilityPermissions(actual: Record<string, string>, expected: Record<string, string>) {
  for (const [key, value] of Object.entries(actual)) {
    if (expected[key] !== value) throw new GithubPermissionError("GitHub granted an unexpected capability.");
  }
  for (const [key, value] of Object.entries(expected)) {
    if (actual[key] !== value) throw new GithubPermissionError("GitHub did not grant the required capability.");
  }
}
/** App grants differ from per-operation token grants. Writes are never requested by scans. */
export function assertAppPermissions(actual: Record<string, string>) {
  for (const [key, value] of Object.entries(actual)) {
    if (value === "read" && (READ_ONLY_SCOPES as readonly string[]).includes(key)) continue;
    if (key === "checks" && value === "write") continue;
    if (key === "pull_requests" && value === "write" && process.env.AEGIS_GITHUB_PR_WRITE === "true") continue;
    throw new GithubPermissionError("GitHub App has an unexpected permission.");
  }
  if (actual.contents !== "read" || actual.metadata !== "read") throw new GithubPermissionError("GitHub read permissions are required.");
}
