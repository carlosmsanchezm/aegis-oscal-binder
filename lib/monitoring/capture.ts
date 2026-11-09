import { createHash } from "node:crypto";
import { sealCollectedArtifact } from "../collector/seal";
import type { CollectedArtifact } from "../collector/types";
import { canonicalRepo, canonicalTimestamp } from "./safety";
import type { SourceCaptureDocument } from "./types";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function excludedOf(value: unknown): { path: string; reason: string }[] {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 5000) throw new Error("Invalid source capture.");
  return value.map(item => {
    if (!item || typeof item !== "object") throw new Error("Invalid source capture.");
    const row = item as { path?: unknown; reason?: unknown };
    if (typeof row.path !== "string" || !row.path || row.path.length > 500 || row.path.startsWith("/") || row.path.split("/").includes("..") || /[\u0000-\u001f]/.test(row.path)) throw new Error("Invalid source capture.");
    if (typeof row.reason !== "string" || !row.reason.trim() || row.reason.length > 500) throw new Error("Invalid source capture.");
    return { path: row.path, reason: row.reason.trim() };
  });
}

/** Project an uploaded document onto aegis.source-capture.v1. Events are regenerated, not stored twice. */
export function canonicalCapture(value: unknown): SourceCaptureDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid source capture.");
  const body = value as { schema?: unknown; captures?: unknown };
  if (body.schema !== "aegis.source-capture.v1" || !Array.isArray(body.captures) || !body.captures.length || body.captures.length > 10) throw new Error("Invalid source capture.");
  const captures = body.captures.map(raw => {
    if (!raw || typeof raw !== "object") throw new Error("Invalid source capture.");
    const capture = raw as { source?: { repo?: unknown; commit?: unknown; capturedAt?: unknown }; artifacts?: unknown; excluded?: unknown };
    if (!capture.source || typeof capture.source.repo !== "string" || typeof capture.source.commit !== "string" || typeof capture.source.capturedAt !== "string") throw new Error("Invalid source capture.");
    const source = { repo: canonicalRepo(capture.source.repo), commit: capture.source.commit, capturedAt: canonicalTimestamp(capture.source.capturedAt) };
    if (!/^[a-f0-9]{40,64}$/.test(source.commit)) throw new Error("Invalid source capture.");
    if (!Array.isArray(capture.artifacts) || !capture.artifacts.length || capture.artifacts.length > 1000) throw new Error("Invalid source capture.");
    const artifacts = capture.artifacts.map(artifact => {
      const sealed = sealCollectedArtifact(artifact);
      if (sealed.source.kind === "aws-account") throw new Error("Invalid source capture.");
      if (canonicalRepo(sealed.source.repo) !== source.repo || sealed.source.commit !== source.commit || sealed.capturedAt !== source.capturedAt) throw new Error("Invalid source capture.");
      return sealed.source.repo === source.repo ? sealed : { ...sealed, source: { ...sealed.source, repo: source.repo } };
    });
    const resealed = artifacts.map(artifact => artifact.source.repo === source.repo ? artifact : sealCollectedArtifact({ ...artifact, source: { ...artifact.source, repo: source.repo } }));
    if (new Set(resealed.map(a => a.name)).size !== resealed.length) throw new Error("Invalid source capture.");
    const excluded = excludedOf(capture.excluded);
    resealed.sort((a, b) => a.name.localeCompare(b.name));
    return { source, artifacts: resealed, ...(excluded.length ? { excluded } : {}) };
  });
  return { schema: "aegis.source-capture.v1", captures };
}

export function captureBytes(document: SourceCaptureDocument): string {
  return JSON.stringify(document);
}

export function captureHash(document: SourceCaptureDocument): string {
  return sha256(captureBytes(document));
}

export function captureArtifacts(document: SourceCaptureDocument): CollectedArtifact[] {
  return document.captures.flatMap(capture => capture.artifacts);
}

export function assertCommitPin(document: SourceCaptureDocument, revision: string): void {
  const commits = new Set(document.captures.map(capture => capture.source.commit));
  if (!commits.has(revision)) throw new Error("Capture commit does not match the trigger.");
}
