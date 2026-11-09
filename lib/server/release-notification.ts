import type { EvidenceEvent } from "../builder/evidence";
import { connectedPrRepo, prLocators } from "../github/pull-requests";
import { collectAndRetainRelease } from "../collector/trusted-release";

/** A connection-authenticated pipeline event is a trigger, never collected proof itself. */
export async function collectNotifiedRelease(connectionId: string, event: EvidenceEvent) {
  if (event.run.producer !== "GitHub Actions" || !/^[1-9][0-9]*$/.test(event.run.id) || !Number.isSafeInteger(Number(event.run.id)))
    return "not-applicable";
  try {
    const g = await connectedPrRepo(connectionId);
    if (event.subject.id.toLowerCase() !== ("https://github.com/" + g.owner + "/" + g.repo).toLowerCase()) return "not-applicable";
    const sessions = [...new Set((await prLocators(g.installationId, g.owner, g.repo))
      .filter(row => row.connectionId === connectionId).map(row => row.sessionId))];
    if (!sessions.length) return "no-linked-session";
    if (sessions.length > 20) return "unavailable";
    for (const session of sessions) await collectAndRetainRelease(connectionId, session, {...g, runId: Number(event.run.id)});
    return "collected";
  } catch {
    // Preserve successful notification intake without granting proof on a failed provider read.
    return "unavailable";
  }
}
