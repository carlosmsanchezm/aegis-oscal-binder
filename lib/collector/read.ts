import {accountTarget} from "./aws/account";
import { SOURCE_KINDS } from "./registry";
import type { CollectedArtifact } from "./types";

/** Validate bounded safe metadata at every intake. Producers remain unverified. */
export function readCollectedArtifact(value: unknown): CollectedArtifact | null {
  if (!value || typeof value !== "object" || (value as { schema?: string }).schema !== "aegis.collected-artifact.v1") return null;
  const a = value as CollectedArtifact;
  if (!/^source-[a-f0-9]{24}\.json$/.test(a.name) || typeof a.type !== "string" || a.type.length > 100 || !a.source
    || !/^[a-f0-9]{64}$/.test(a.sha256) || !Number.isFinite(Date.parse(a.capturedAt))
    || !Array.isArray(a.facts) || a.facts.length > 1000 || !Array.isArray(a.limitations) || a.limitations.length > 10 || a.limitations.some(l => typeof l !== "string" || l.length > 1000)) throw new Error("Invalid collected artifact metadata.");
  if (a.source.kind && !(SOURCE_KINDS as readonly string[]).includes(a.source.kind)) throw new Error("Invalid source kind.");
  const facts = readFacts(a);
  const limitations = [...a.limitations];
  if (a.source.kind === "aws-account") {
    if ("repo" in a.source || "commit" in a.source) throw new Error("An aws-account source does not use a git repo or commit.");
    accountTarget({partition:a.source.partition as "aws"|"aws-us-gov",allowedAccountIds:[a.source.account],regions:[a.source.region]});
    if (typeof a.source.path !== "string" || a.source.path.length > 500 || a.source.path.startsWith("/") || a.source.path.split("/").includes("..") || /[\u0000-\u001f]/.test(a.source.path)) throw new Error("Invalid collected artifact metadata.");
    if (!/^[a-f0-9]{64}$/.test(a.source.sha256)) throw new Error("Invalid collected artifact metadata.");
    return { schema: a.schema, name: a.name, type: a.type, source: { kind: "aws-account", account: a.source.account, partition: a.source.partition, region: a.source.region, path: a.source.path, sha256: a.source.sha256 }, capturedAt: a.capturedAt, facts, limitations, sha256: a.sha256 };
  }
  if (!/^[a-f0-9]{40,64}$/.test(a.source.commit) || !/^[a-f0-9]{64}$/.test(a.source.sha256)
    || typeof a.source.path !== "string" || a.source.path.length > 500 || a.source.path.startsWith("/") || a.source.path.split("/").includes("..")
    || /[\u0000-\u001f]/.test(a.source.path)) throw new Error("Invalid collected artifact metadata.");
  const url = new URL(a.source.repo);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("Invalid collected source URL.");
  if (a.source.url) { const href = new URL(a.source.url); if (href.protocol !== "https:" || href.username || href.password || href.search || href.hash) throw new Error("Invalid source link."); }
  return { schema: a.schema, name: a.name, type: a.type, source: { repo: a.source.repo, commit: a.source.commit, path: a.source.path, sha256: a.source.sha256, ...(a.source.kind ? { kind: a.source.kind } : {}), ...(a.source.url ? { url: a.source.url } : {}) }, capturedAt: a.capturedAt, facts, limitations, sha256: a.sha256 };
}

function readFacts(a: CollectedArtifact) {
  for (const f of a.facts) {
    if (typeof f.key !== "string" || !/^[a-z-]{1,80}$/.test(f.key) || !Number.isSafeInteger(f.line) || f.line < 1
      || typeof f.field !== "string" || f.field.length > 1000 || !/^[\w.\[\]$/:-]+$/.test(f.field)
      || !["string", "boolean", "number"].includes(typeof f.value) || (typeof f.value === "number" && !Number.isFinite(f.value))
      || (typeof f.value === "string" && (!/^[\w./:@+*=();, -]{1,250}$/.test(f.value) || /password|token|private.key/i.test(f.value)))
      || f.content !== `${f.field} = ${f.value}` || (f.outcome !== undefined && f.outcome !== "fail")) throw new Error("Invalid extracted fact.");
    if (f.fixPaths !== undefined && (!Array.isArray(f.fixPaths) || f.fixPaths.length > 100 || f.fixPaths.some(p => typeof p !== "string" || !/^[A-Za-z0-9_.@/-]{1,500}$/.test(p) || p.startsWith("/") || p.split("/").some(s => !s || s === "." || s === "..")))) throw new Error("Invalid remediation path scope.");
    if (f.resourceIds !== undefined && (!Array.isArray(f.resourceIds) || f.resourceIds.length > 100 || f.resourceIds.some(r => typeof r !== "string" || !/^[A-Za-z0-9_.:/@-]{1,1000}$/.test(r)))) throw new Error("Invalid remediation resource scope.");
    if (f.ksi != null && (typeof f.ksi !== "string" || !/^KSI(?:-[A-Z0-9]+)+$/.test(f.ksi.toUpperCase()))) throw new Error("Invalid extracted fact.");
  }
  return a.facts.map(f => ({ key: f.key, value: f.value, line: f.line, field: f.field, content: f.content, ...(f.outcome ? { outcome: f.outcome } : {}), ...(f.fixPaths ? {fixPaths:[...f.fixPaths]} : {}), ...(f.resourceIds ? {resourceIds:[...f.resourceIds]} : {}), ...(f.ksi ? { ksi: f.ksi.toUpperCase() } : {}) }));
}
