import { repoScanner } from "./adapters/repo-scanner";
import { registerCollector } from "./registry";

let loaded = false;

/**
 * Built-in collectors. Parallel branches add their adapter here and call `registerCollector`.
 *
 * GitHub App (`cursor/github-repo-connection`):
 *   import { githubAppCollector } from "../github/collector";
 *   registerCollector(githubAppCollector);
 *
 * AWS GovCloud reader (`cursor/aws-govcloud-reader`):
 *   import { awsGovCloudCollector } from "../aws/collector";
 *   registerCollector(awsGovCloudCollector);
 *
 * A schedule adapter implements `scheduledScans` and returns source-capture documents.
 * It does not import drift, the hash chain, the gate, or a second store.
 */
export function loadCollectors(): void {
  if (loaded) return;
  loaded = true;
  registerCollector(repoScanner);
}
