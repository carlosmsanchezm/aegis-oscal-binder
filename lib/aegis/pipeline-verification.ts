import type { PipelineEvidence } from "./pipeline-evidence";

/** Measured results plus separately authored engineering notes; never a reviewer decision. */
export type PipelineVerification = {
  sourcePipelineUrl: string; sourceCommit: string; sourceReleaseSha256: string;
  tests: { description: string; artifact: string; artifactSha256: string; result: string; verdict: "pass" | "fail"; date: string }[];
  engineering?: {
    owner: string; action: string; risk: string; resources: string; protection: string;
    milestones: { id: string; description: string; target: string; revised: string; reason: string; status: "Not started" | "In progress" | "Delayed" | "Done" }[];
  };
};

export function parsePipelineVerification(value: unknown, record: PipelineEvidence): PipelineVerification {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid measured verification.");
  const v = value as Record<string, unknown>;
  const str = (x: unknown, max = 12000): string => {
    if (typeof x !== "string" || !x.trim() || x.length > max || /[\u0000-\u001f]/.test(x)) throw new Error("Invalid verification field.");
    return x;
  };
  const hash = (x: unknown) => { const h = str(x, 64); if (!/^[a-f0-9]{64}$/.test(h)) throw new Error("Invalid verification hash."); return h; };
  const date = (x: unknown) => { const d = str(x, 10); if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || new Date(d).toISOString().slice(0, 10) !== d) throw new Error("Invalid verification date."); return d; };
  const sourcePipelineUrl = str(v.sourcePipelineUrl, 500), sourceCommit = str(v.sourceCommit, 100);
  const url = new URL(sourcePipelineUrl);
  if (url.protocol !== "https:" || url.username || url.password || sourcePipelineUrl === record.pipelineUrl || sourceCommit === record.commitSha) throw new Error("Verification requires a distinct original release.");
  if (!Array.isArray(v.tests) || !v.tests.length || v.tests.length > 30) throw new Error("Invalid verification tests.");
  const tests = v.tests.map(raw => {
    if (!raw || typeof raw !== "object") throw new Error("Invalid verification test.");
    const t = raw as Record<string, unknown>, artifact = str(t.artifact, 80);
    if (!/^[A-Za-z0-9_.-]+$/.test(artifact) || artifact.includes("..") || !record.artifacts?.includes(artifact)) throw new Error("Verification artifact is outside the release inventory.");
    if (t.verdict !== "pass" && t.verdict !== "fail") throw new Error("Invalid measured verdict.");
    return { description: str(t.description, 1000), artifact, artifactSha256: hash(t.artifactSha256), result: str(t.result), verdict: t.verdict as "pass" | "fail", date: date(t.date) };
  });
  if (new Set(tests.map(t => t.description)).size !== tests.length) throw new Error("Duplicate verification tests.");
  let engineering: PipelineVerification["engineering"];
  if (v.engineering != null) {
    const e = v.engineering as Record<string, unknown>;
    if (!Array.isArray(e.milestones) || !e.milestones.length || e.milestones.length > 50) throw new Error("Invalid engineering milestones.");
    engineering = { owner: str(e.owner), action: str(e.action), risk: str(e.risk), resources: str(e.resources), protection: str(e.protection), milestones: e.milestones.map(raw => {
      const m = raw as Record<string, unknown>;
      if (!m || !["Not started", "In progress", "Delayed", "Done"].includes(String(m.status)) || typeof m.revised !== "string" || typeof m.reason !== "string" || m.reason.length > 12000) throw new Error("Invalid engineering milestone.");
      return { id: str(m.id, 120), description: str(m.description), target: date(m.target), revised: m.revised ? date(m.revised) : "", reason: m.reason, status: m.status as "Done" };
    }) };
  }
  return { sourcePipelineUrl, sourceCommit, sourceReleaseSha256: hash(v.sourceReleaseSha256), tests, ...(engineering ? { engineering } : {}) };
}
