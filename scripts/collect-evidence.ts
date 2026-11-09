import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { localSourceTree, sourceCapture, sourceCaptureDocument, walkSourceTree } from "../lib/collector/source-tree";
import type { GitEvidenceSource } from "../lib/collector/types";

// Config contains directories and public source pins, never upload credentials.
const configPath = process.argv[2], out = process.argv[3];
if (!configPath || !out) throw new Error("Usage: npx tsx scripts/collect-evidence.ts sources.json output-directory");
const config = JSON.parse(readFileSync(configPath, "utf8")) as { sources: { directory: string; repo: string; commit: string; capturedAt: string; git?: boolean; sourceKind?: GitEvidenceSource["sourceKind"]; sourceUrl?: string }[] };
mkdirSync(out, { recursive: true });
const captures = [];
for (const source of config.sources) {
  if (source.git !== false && execFileSync("git", ["rev-parse", "HEAD"], { cwd: source.directory, encoding: "utf8" }).trim() !== source.commit) throw new Error("Source checkout differs from its declared pin.");
  if (source.git !== false && execFileSync("git", ["status", "--porcelain", "--untracked-files=normal"], { cwd: source.directory, encoding: "utf8" }).trim()) throw new Error("Use a clean source checkout; supply generated outputs as a separate source directory.");
  const pin = { repo: source.repo, commit: source.commit, capturedAt: source.capturedAt, ...(source.sourceKind ? { sourceKind: source.sourceKind } : {}), ...(source.sourceUrl ? { sourceUrl: source.sourceUrl } : {}) };
  const walked = await walkSourceTree(localSourceTree(source.directory), pin);
  const capture = sourceCapture(walked.files, walked.excluded, pin);
  capture.events.forEach((event) => writeFileSync(path.join(out, `event-${event.id}.json`), event.rawEvent));
  captures.push(capture);
}
writeFileSync(path.join(out, "capture.json"), JSON.stringify(sourceCaptureDocument(captures), null, 2));
console.log(captures.map((capture) => ({ source: capture.source, artifacts: capture.artifacts.length, facts: capture.artifacts.reduce((count, artifact) => count + artifact.facts.length, 0), batches: capture.events.length })));
