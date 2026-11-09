import type {PipelineEvidence} from "./pipeline-evidence";

/**
 * Name taken from the newest stored release URL. Any uploaded system uses the same path.
 * The Podinfo project name is data on that URL, not a special case in this function.
 */
export function releaseSystemName(releases: PipelineEvidence[]): string {
  const newest = [...releases].sort((a, b) => {
    const left = Date.parse(a.createdAt);
    const right = Date.parse(b.createdAt);
    return (Number.isNaN(right) ? 0 : right) - (Number.isNaN(left) ? 0 : left) || b.pipelineId.localeCompare(a.pipelineId);
  })[0];
  if (!newest) return "Stored releases";
  if (newest.schema === "aegis.evidence-event.v1") return newest.observation.systemName;
  try {
    const parts = new URL(newest.pipelineUrl).pathname.split("/").filter(Boolean);
    const dash = parts.indexOf("-");
    const name = dash > 0 ? parts[dash - 1] : parts[0];
    if (name) return name;
  } catch {
    // A release URL that is not absolute keeps the generic label.
  }
  return "Stored releases";
}

