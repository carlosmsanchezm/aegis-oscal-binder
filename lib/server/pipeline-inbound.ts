import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { readdirSync } from "node:fs";
import path from "node:path";
import { dataDir, findRepoRoot } from "@/lib/aegis/paths";
import { normalizePipelineEvent, parseStoredPipelineEvidence, PIPELINE_WEBHOOK_PATH } from "@/lib/aegis/pipeline-inbound";
import type { PipelineEvidence } from "@/lib/aegis/pipeline-evidence";
import { blobGetText, blobPutText, listBlobPathnames, persistenceMode, PIPELINE_RELEASE_PREFIX } from "@/lib/durable";
import { getStorage } from "@/lib/storage";

export const PIPELINE_WEBHOOK_SECRET_ENV = "AEGIS_PIPELINE_WEBHOOK_SECRET";
const MAX_BODY = 512_000;

export type StoredPipelineRelease = {
  receivedAt: string;
  evidence: PipelineEvidence;
};

export type AcceptResult =
  | { ok: true; evidence: PipelineEvidence }
  | { ok: false; status: number; code: string; message: string };

export type ReleaseScreenSeed = {
  evidence: PipelineEvidence | null;
  configured: boolean;
  webhookPath: string;
  receivedAt: string | null;
  releases?: StoredPipelineRelease[];
  storage?: "durable" | "local" | "unavailable";
};

export function pipelineWebhookSecret(): string | null {
  const value = process.env[PIPELINE_WEBHOOK_SECRET_ENV]?.trim() ?? "";
  return value ? value : null;
}

export function signPipelineBody(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

export function verifyPipelineSignature(body: string, header: string | null, secret: string | null): "ok" | "missing-secret" | "rejected" {
  if (!secret) return "missing-secret";
  const match = /^sha256=([0-9a-f]{64})$/i.exec(header?.trim() ?? "");
  if (!match) return "rejected";
  const provided = Buffer.from(match[1], "hex");
  const expected = Buffer.from(signPipelineBody(body, secret), "hex");
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return "rejected";
  return "ok";
}

/** Verify the shared secret, then normalize. Does not record validation or closure. */
export function acceptPipelineEvent(body: string, signatureHeader: string | null, secret: string | null): AcceptResult {
  if (body.length > MAX_BODY) {
    return { ok: false, status: 413, code: "PAYLOAD_TOO_LARGE", message: "Pipeline event exceeds 500 KB." };
  }
  const verdict = verifyPipelineSignature(body, signatureHeader, secret);
  if (verdict === "missing-secret") {
    return { ok: false, status: 401, code: "WEBHOOK_UNCONFIGURED", message: "Pipeline webhook secret is not configured." };
  }
  if (verdict === "rejected") {
    return { ok: false, status: 401, code: "WEBHOOK_REJECTED", message: "Pipeline event signature was missing or did not match." };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    return { ok: false, status: 400, code: "BAD_REQUEST", message: "Pipeline event must be a JSON object." };
  }
  try {
    return { ok: true, evidence: normalizePipelineEvent(parsed) };
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : "Invalid pipeline event.";
    return { ok: false, status: 400, code: "INVALID_EVENT", message };
  }
}

const PREFIX = PIPELINE_RELEASE_PREFIX;
function requirePersistence(): void {
  persistenceMode();
}
export function releaseRecordKey(evidence: PipelineEvidence): string {
  // Normalization fixes field order. Identical replays are idempotent; enriched
  // notifications retain another immutable version instead of erasing evidence.
  return createHash("sha256").update(JSON.stringify(parseStoredPipelineEvidence(evidence))).digest("hex");
}
function parseRelease(value: unknown): StoredPipelineRelease {
  const record = value as StoredPipelineRelease;
  if (!record || typeof record.receivedAt !== "string" || !Number.isFinite(Date.parse(record.receivedAt))) throw new Error("Invalid received time.");
  return { receivedAt: record.receivedAt, evidence: parseStoredPipelineEvidence(record.evidence) };
}
async function readBlob(name: string): Promise<StoredPipelineRelease | null> {
  const text = await blobGetText(name);
  if (text == null) return null;
  if (text.length > MAX_BODY) throw new Error("Invalid stored release size.");
  return parseRelease(JSON.parse(text));
}
export async function writeSelectedRelease(release: StoredPipelineRelease, root = findRepoRoot()): Promise<StoredPipelineRelease> {
  requirePersistence();
  const evidence = parseStoredPipelineEvidence(release.evidence);
  const normalized = parseRelease({ receivedAt: release.receivedAt, evidence });
  const name = `${PREFIX}${releaseRecordKey(evidence)}.json`;
  if (persistenceMode() === "blob") {
    const existing = await readBlob(name);
    if (existing) return existing;
    try {
      await blobPutText(name, JSON.stringify(normalized), false);
    } catch {
      // Concurrent duplicate writes may lose the create race, not the evidence.
      const duplicate = await readBlob(name);
      if (!duplicate) throw new Error("Could not persist release.");
      return duplicate;
    }
  } else {
    const file = path.join(dataDir(root), "pipeline-inbound", "history", `${releaseRecordKey(evidence)}.json`);
    const storage = getStorage();
    if (storage.exists(file)) return parseRelease(JSON.parse(storage.read(file).toString("utf8")));
    storage.write(file, JSON.stringify(normalized));
  }
  return normalized;
}

export async function readReleaseHistory(root = findRepoRoot()): Promise<StoredPipelineRelease[]> {
  requirePersistence();
  const records: StoredPipelineRelease[] = [];
  if (persistenceMode() === "blob") {
    // Separate immutable records avoid read/modify/write index races.
    const blobs = await listBlobPathnames(PREFIX);
    blobs.sort((a, b) => b.uploadedAt - a.uploadedAt);
    const loaded = await Promise.all(blobs.slice(0, 100).map(blob => readBlob(blob.pathname)));
    records.push(...loaded.filter((record): record is StoredPipelineRelease => record !== null));
  } else {
    const dir = path.join(dataDir(root), "pipeline-inbound", "history"), storage = getStorage();
    if (storage.exists(dir)) for (const name of readdirSync(dir).filter(n => /^[a-f0-9]{64}\.json$/.test(n))) {
      try { records.push(parseRelease(JSON.parse(storage.read(path.join(dir, name)).toString("utf8")))); } catch { /* Invalid local records stay off screen. */ }
    }
    const legacy = path.join(dataDir(root), "pipeline-inbound", "selected.json");
    if (!records.length && storage.exists(legacy)) {
      try { records.push(parseRelease(JSON.parse(storage.read(legacy).toString("utf8")))); } catch { /* Invalid legacy record. */ }
    }
  }
  records.sort((a, b) => Date.parse(b.evidence.createdAt) - Date.parse(a.evidence.createdAt) || Number(!!b.evidence.verification) - Number(!!a.evidence.verification) || Date.parse(b.receivedAt) - Date.parse(a.receivedAt));
  const unique = new Map<string, StoredPipelineRelease>();
  for (const record of records) {
    const key = `${record.evidence.pipelineUrl}:${record.evidence.commitSha}:${record.evidence.releaseSha256}`;
    if (!unique.has(key)) unique.set(key, record);
  }
  return [...unique.values()].slice(0, 50);
}
export async function readSelectedRelease(root = findRepoRoot()): Promise<StoredPipelineRelease | null> { return (await readReleaseHistory(root))[0] ?? null; }
export async function releaseScreenSeed(root = findRepoRoot()): Promise<ReleaseScreenSeed> {
  try {
    const releases = await readReleaseHistory(root), selected = releases[0];
    return {
      evidence: selected?.evidence ?? null,
      configured: pipelineWebhookSecret() !== null,
      webhookPath: PIPELINE_WEBHOOK_PATH,
      receivedAt: selected?.receivedAt ?? null,
      releases,
      storage: persistenceMode() === "blob" ? "durable" : "local",
    };
  } catch {
    return { evidence: null, configured: pipelineWebhookSecret() !== null, webhookPath: PIPELINE_WEBHOOK_PATH, receivedAt: null, storage: "unavailable" };
  }
}
