import { monitoringCopy } from "../copy";
import { canonicalCapture } from "../capture";
import type { CollectorAdapter } from "../registry";

/** The in-repo scanner. Callers supply a capture they already collected. This adapter does not clone or call remotes. */
export const repoScanner: CollectorAdapter = {
  id: "repo-scanner",
  triggers: ["webhook", "ci"],
  async collect(input) {
    if (input.capture == null) throw new Error(monitoringCopy.remoteFetchRefused);
    return canonicalCapture(input.capture);
  },
};
