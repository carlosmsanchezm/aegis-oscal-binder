import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import { GithubPermissionError, GithubRequestError, githubAppConfig, redactSecrets, silentLog, type GithubAppConfig } from "./config";
import { assertReadOnlyPermissions, LIST_PERMISSIONS, SCAN_PERMISSIONS, RELEASE_PERMISSIONS, PR_READ_PERMISSIONS, PR_OPEN_PERMISSIONS, GATE_PERMISSIONS, assertCapabilityPermissions } from "./permissions";
import {freshTokenRead} from "./token-replication";

const noStore = {
  get(): string | undefined {
    return undefined;
  },
  set(): undefined {
    return undefined;
  },
};

export type InstallationClient = {
  octokit: Octokit;
  permissions: Record<string, string>;
};

type MintOptions = {
  installationId: number;
  permissions: Record<string, string>;
  repositoryNames?: string[];
  required: readonly string[];
  config?: GithubAppConfig;
  capability?: "pr-read" | "pr-open" | "gate";
};

/**
 * Mint one independent installation token with the exact requested capability,
 * and revoke it when the caller finishes. It is never returned or cached.
 */
export async function withInstallation<T>(options: MintOptions, run: (client: InstallationClient) => Promise<T>): Promise<T> {
  const config = options.config ?? githubAppConfig();
  const auth = createAppAuth({
    appId: config.appId,
    privateKey: config.privateKey,
    cache: noStore as unknown as { get: (key: string) => string; set: (key: string, value: string) => unknown },
    log: silentLog,
  });
  let authentication: {token:string;permissions:Record<string,string>};
  try {
    // auth-app's installation path globally coalesces overlapping mints, even
    // with a no-op cache. Independent finally/revoke boundaries must never
    // share that credential or mutate another operation's authentication.
    const app=await auth({type:"app"});
    const minted=await new Octokit({auth:app.token,userAgent:"aegis-source-collector",log:silentLog}).request("POST /app/installations/{installation_id}/access_tokens",{
      installation_id: options.installationId,
      permissions: options.permissions,
      ...(options.repositoryNames ? { repositories: options.repositoryNames } : {}),
    });
    authentication={token:minted.data.token,permissions:minted.data.permissions??{}};
  } catch (error) {
    throw cleanRequestError(error);
  }
  let token = authentication.token;
  authentication.token = "";
  try {
    if (options.capability) {
      if (options.capability === "pr-open" && process.env.AEGIS_GITHUB_PR_WRITE !== "true") throw new GithubPermissionError("PR creation is disabled.");
      assertCapabilityPermissions(authentication.permissions, options.capability === "pr-read" ? PR_READ_PERMISSIONS : options.capability === "pr-open" ? PR_OPEN_PERMISSIONS : GATE_PERMISSIONS);
    } else assertReadOnlyPermissions(authentication.permissions, options.required);
    const octokit = new Octokit({ auth: token, userAgent: "aegis-source-collector", log: silentLog });
    const mintedAt=Date.now();
    octokit.hook.wrap("request",(request,options)=>freshTokenRead(options.method??"GET",mintedAt,async()=>request(options)));
    const result = await run({ octokit, permissions: authentication.permissions });
    if (token && JSON.stringify(result)?.includes(token)) throw new GithubPermissionError("GitHub token was not retained.");
    return result;
  } catch (error) {
    if (error instanceof GithubPermissionError || error instanceof GithubRequestError) throw error;
    throw cleanRequestError(error);
  } finally {
    const minted = token;
    token = "";
    await revokeInstallationToken(minted);
  }
}

export function withScanInstallation<T>(installationId: number, repository: string, run: (client: InstallationClient) => Promise<T>): Promise<T> {
  return withInstallation({
    installationId,
    permissions: { ...SCAN_PERMISSIONS },
    repositoryNames: [repository],
    required: ["contents", "metadata"],
  }, run);
}

export function withListInstallation<T>(installationId: number, run: (client: InstallationClient) => Promise<T>): Promise<T> {
  return withInstallation({
    installationId,
    permissions: { ...LIST_PERMISSIONS },
    required: ["metadata"],
  }, run);
}

async function revokeInstallationToken(token: string): Promise<void> {
  if (!token) return;
  try {
    await fetch("https://api.github.com/installation/token", {
      method: "DELETE",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "user-agent": "aegis-source-collector",
        "x-github-api-version": "2022-11-28",
      },
    });
  } catch {
    // A failed revoke must not surface the token. The scan result is already decided.
  }
}

function cleanRequestError(error: unknown): GithubRequestError {
  const status = typeof error === "object" && error && "status" in error && typeof (error as { status: unknown }).status === "number"
    ? (error as { status: number }).status
    : 0;
  if ([404,422].includes(status) && typeof error === "object" && error) {
    // Retain only fixed diagnostic categories, never provider messages, values,
    // request bodies, headers or URLs that could carry credentials/source data.
    const e = error as {request?: {method?: string; url?: string}; response?: {data?: {errors?: {field?: string; code?: string}[]}}};
    const url = e.request?.url ?? "";
    const operation = /\/access_tokens(?:\?|$)/.test(url) ? "mint-installation-token" : /\/check-runs\/[0-9]+(?:\?|$)/.test(url) ? "check-run-update" : /\/check-runs(?:\?|$)/.test(url) ? "check-runs-read-or-create" : /\/pulls\/[0-9]+\/files(?:\?|$)/.test(url) ? "pull-request-files" : /\/pulls(?:\/|\?|$)/.test(url) ? "pull-request" : "github-operation";
    const fields = (Array.isArray(e.response?.data?.errors) ? e.response.data.errors : []).flatMap(x =>
      ["head", "base", "title", "permissions", "repositories", "repository_names"].includes(x.field ?? "") && ["invalid", "missing", "missing_field", "already_exists", "custom"].includes(x.code ?? "") ? [{field:x.field,code:x.code}] : []);
    const prNumber=Number(/\/pulls\/([1-9][0-9]*)(?:\/|\?|$)/.exec(url)?.[1]);
    const method=["GET","HEAD","POST","PATCH","DELETE"].includes(e.request?.method??"")?e.request!.method:"unknown";
    console.error("GitHub operation rejected", {status, operation, method, ...(Number.isSafeInteger(prNumber)?{prNumber}:{}), fields});
  }
  if (error instanceof Error && redactSecrets(error.message) !== error.message) {
    return new GithubRequestError(status);
  }
  return new GithubRequestError(status);
}

export function withReleaseInstallation<T>(installationId:number,repository:string,run:(client:InstallationClient)=>Promise<T>):Promise<T>{
 return withInstallation({installationId,permissions:{...RELEASE_PERMISSIONS},repositoryNames:[repository],required:["actions","contents","metadata"]},run);
}

export function withPrInstallation<T>(installationId: number, repository: string, capability: "pr-read" | "pr-open" | "gate", run: (client: InstallationClient) => Promise<T>): Promise<T> {
  if (capability === "pr-open" && process.env.AEGIS_GITHUB_PR_WRITE !== "true") throw new GithubPermissionError("PR creation is disabled.");
  const permissions = capability === "pr-read" ? PR_READ_PERMISSIONS : capability === "pr-open" ? PR_OPEN_PERMISSIONS : GATE_PERMISSIONS;
  return withInstallation({ installationId, repositoryNames: [repository], permissions: {...permissions}, required: [], capability }, run);
}
