import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {readCollectedArtifact} from "../collector/read";
import { BUILDER_BUNDLE_SCHEMA, MAX_EVENT_BYTES, parseEvidenceEvent, type EvidenceBundle } from "@/lib/builder/evidence";
import { blobGetText, blobPutText, builderStoragePrefix, listBlobPathnames, persistenceMode } from "@/lib/durable";
import { dataDir, findRepoRoot } from "@/lib/aegis/paths";

const PREFIX = builderStoragePrefix();
export const BUILDER_COOKIE = "aegis_builder_owner";
export type BuilderConnection = { id: string; name: string; ownerHash: string; tokenHash: string; createdAt: string; revokedAt?: string; github?: { installationId: number; owner: string; repo: string } };
export function sha256(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }
function id(value: string): string {
  if (!/^[0-9a-f-]{36}$/.test(value)) throw new Error("Invalid connection ID.");
  return value;
}
function sameHash(a: string, b: string): boolean {
  return /^[a-f0-9]{64}$/.test(a) && /^[a-f0-9]{64}$/.test(b) && timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}
export function builderOwner(rawCookie: string | null): string | null {
  const value = (rawCookie ?? "").split(";").map(p => p.trim()).find(p => p.startsWith(`${BUILDER_COOKIE}=`))?.slice(BUILDER_COOKIE.length + 1);
  return value && /^[a-f0-9]{64}$/.test(value) ? value : null;
}
function localFile(key: string, root: string): string { return path.join(dataDir(root), key); }
async function read(key: string, root: string): Promise<string | null> {
  if (persistenceMode() === "blob") return blobGetText(key);
  try { return readFileSync(localFile(key, root), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
async function writeOnce(key: string, value: string, root: string): Promise<void> {
  if (persistenceMode() === "blob") { await blobPutText(key, value, false); return; }
  const file = localFile(key, root);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, value, { flag: "wx", mode: 0o600 });
}
async function keys(prefix: string, root: string): Promise<string[]> {
  if (persistenceMode() === "blob") return (await listBlobPathnames(prefix)).map(b => b.pathname);
  try { return readdirSync(localFile(prefix, root)).filter(n => /^[a-f0-9-]+\.json$/.test(n)).map(n => `${prefix}${n}`); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}
function connectionKey(connectionId: string): string { return `${PREFIX}connections/${id(connectionId)}.json`; }
function ownerKey(owner: string, connectionId: string): string { return `${PREFIX}owners/${sha256(owner)}/${id(connectionId)}.json`; }
export async function createConnection(name: string, owner?: string | null, root = findRepoRoot()) {
  if (!name.trim() || name.length > 100 || /[\u0000-\u001f]/.test(name)) throw new Error("Invalid system name.");
  const ownerSecret = owner ?? randomBytes(32).toString("hex"), token = randomBytes(32).toString("hex");
  const connection: BuilderConnection = { id: randomUUID(), name: name.trim(), ownerHash: sha256(ownerSecret), tokenHash: sha256(token), createdAt: new Date().toISOString() };
  await writeOnce(connectionKey(connection.id), JSON.stringify(connection), root);
  await writeOnce(ownerKey(ownerSecret, connection.id), JSON.stringify({ id: connection.id }), root);
  return { connection, owner: ownerSecret, token };
}
export async function readConnection(connectionId: string, root = findRepoRoot()): Promise<BuilderConnection | null> {
  const raw = await read(connectionKey(connectionId), root);
  if (!raw) return null;
  const c = JSON.parse(raw) as BuilderConnection;
  if (c.id !== connectionId || !c.name || !/^[a-f0-9]{64}$/.test(c.ownerHash) || !/^[a-f0-9]{64}$/.test(c.tokenHash)) throw new Error("Invalid stored connection.");
  const revoked = await read(`${PREFIX}revocations/${connectionId}.json`, root);
  const binding = await read(`${PREFIX}github-bindings/${connectionId}.json`, root);
  if (binding) c.github = JSON.parse(binding);
  return revoked ? { ...c, revokedAt: (JSON.parse(revoked) as { revokedAt: string }).revokedAt } : c;
}
export function ownsConnection(connection: BuilderConnection, owner: string | null): boolean { return !!owner && sameHash(connection.ownerHash, sha256(owner)); }
export function authenticatesConnection(connection: BuilderConnection, token: string | null): boolean { return !connection.revokedAt && !!token && token.length <= 100 && sameHash(connection.tokenHash, sha256(token)); }
export async function revokeConnection(connectionId: string, root = findRepoRoot()): Promise<void> {
  const key = `${PREFIX}revocations/${id(connectionId)}.json`;
  if (await read(key, root)) return;
  try { await writeOnce(key, JSON.stringify({ revokedAt: new Date().toISOString() }), root); }
  catch (error) { if (!(await read(key, root))) throw error; }
}
export async function listConnections(owner: string | null, root = findRepoRoot()): Promise<BuilderConnection[]> {
  if (!owner) return [];
  const indexed = await keys(`${PREFIX}owners/${sha256(owner)}/`, root);
  if (indexed.length > 100) throw new Error("Pilot workspace connection limit reached.");
  const records = await Promise.all(indexed.map(key => readConnection(path.basename(key, ".json"), root)));
  return records.filter((c): c is BuilderConnection => !!c && ownsConnection(c, owner)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Digest check and schema parsing are independent of the producer's reported verdict. */
export function verifyBundle(input: unknown, expectedId?: string): EvidenceBundle {
  if (!input || typeof input !== "object") throw new Error("Invalid evidence bundle.");
  const b = input as EvidenceBundle;
  if (b.schema !== BUILDER_BUNDLE_SCHEMA || typeof b.rawEvent !== "string" || Buffer.byteLength(b.rawEvent) > MAX_EVENT_BYTES || !Number.isFinite(Date.parse(b.receivedAt))) throw new Error("Invalid evidence bundle.");
  id(b.connectionId);
  if (sha256(b.rawEvent) !== b.id || (expectedId && expectedId !== b.id)) throw new Error("Evidence digest mismatch.");
  const event = parseEvidenceEvent(JSON.parse(b.rawEvent));
  if (JSON.stringify(event) !== JSON.stringify(b.event) || b.integrity !== "verified" || !["connection-token", "browser-owner"].includes(b.authentication)) throw new Error("Evidence manifest mismatch.");
  let hasCollected = false;
  for (const artifact of event.artifacts) {
    const bytes = Buffer.from(artifact.contentBase64, "base64");
    if (artifact.mediaType === "application/json") {
      let value: unknown; try {value = JSON.parse(bytes.toString("utf8"));} catch {value = null;}
      const collected = readCollectedArtifact(value);
      if (collected) {
        hasCollected = true;
        if (bytes.toString("utf8") !== JSON.stringify(collected)) throw new Error("Use canonical collected metadata without extra fields.");
        const {sha256: normalizedHash, ...safe} = collected;
        if (artifact.name !== collected.name || sha256(JSON.stringify(safe)) !== normalizedHash) throw new Error("Collected fact digest mismatch.");
      }
    }
    if (bytes.toString("base64") !== artifact.contentBase64 || sha256(bytes) !== artifact.sha256) throw new Error("Artifact digest mismatch.");
  }
  if (hasCollected && b.rawEvent !== JSON.stringify(event)) throw new Error("Use canonical collector events without extra fields.");
  for (const check of event.checks.filter(c => c.id === "http-access-boundary")) {
    if (check.version !== "1.0.0" || !check.artifacts.includes("http-access.json")) throw new Error("Unsupported access-check specification.");
    const artifact = event.artifacts.find(a => a.name === "http-access.json")!;
    let measurement: Record<string, unknown>;
    try { measurement = JSON.parse(Buffer.from(artifact.contentBase64, "base64").toString("utf8")); }
    catch { throw new Error("Invalid HTTP measurement."); }
    if (measurement.schema !== "aegis.http-access-observation.v1" || measurement.observedAt !== event.run.observedAt || JSON.stringify(measurement.subject) !== JSON.stringify(event.subject) || JSON.stringify(measurement.requirement) !== JSON.stringify(check.requirement) || !Array.isArray(measurement.results) || measurement.results.length !== 2) throw new Error("HTTP measurement scope mismatch.");
    const outcomes = measurement.results.map((raw, index) => {
      const result = raw as Record<string, unknown>;
      if (!result || result.name !== (index === 0 ? "required-access" : "prohibited-access") || !(index === 0 ? [200, 201, 204] : [401, 403]).includes(result.expectedStatus as number)) throw new Error("Invalid HTTP measurement criteria.");
      const actual = result.observedStatus;
      if (actual !== null && (!Number.isInteger(actual) || (actual as number) < 100 || (actual as number) > 599)) throw new Error("Invalid HTTP measurement status.");
      const verdict = actual === null ? "unknown" : actual === result.expectedStatus ? "pass" : "fail";
      if (result.verdict !== verdict) throw new Error("HTTP observation contradicts its measured status.");
      return verdict;
    });
    const verdict = outcomes.includes("fail") ? "fail" : outcomes.includes("unknown") ? "unknown" : "pass";
    if (check.verdict !== verdict || measurement.verdict !== verdict) throw new Error("HTTP check contradicts retained observations.");
  }
  return { ...b, event };
}
export async function retainEvent(connectionId: string, rawEvent: string, root = findRepoRoot(), authentication: EvidenceBundle["authentication"] = "connection-token", collectorFetched = false, indexTimeline = true): Promise<EvidenceBundle> {
  if (Buffer.byteLength(rawEvent) > MAX_EVENT_BYTES) throw new Error("Evidence event exceeds 500 KB.");
  const bundle = verifyBundle({ schema: BUILDER_BUNDLE_SCHEMA, id: sha256(rawEvent), connectionId: id(connectionId), receivedAt: new Date().toISOString(), rawEvent, event: parseEvidenceEvent(JSON.parse(rawEvent)), integrity: "verified", authentication });
  if (Date.parse(bundle.event.run.observedAt) > Date.now() + 300_000) throw new Error("Observation time is in the future.");
  const key = `${PREFIX}evidence/${connectionId}/${bundle.id}.json`;
  const existing = await read(key, root);
  if (existing) { const retained=verifyBundle(JSON.parse(existing), bundle.id); if(indexTimeline)await (await import("../timeline/writers")).recordBundleTimeline(retained,collectorFetched,root); return retained; }
  if ((await keys(`${PREFIX}evidence/${connectionId}/`, root)).length >= 500) throw new Error("Pilot history limit reached; indexed storage is required.");
  try { await writeOnce(key, JSON.stringify(bundle), root); }
  catch (error) {
    const duplicate = await read(key, root);
    if (duplicate) return verifyBundle(JSON.parse(duplicate), bundle.id);
    throw error;
  }
  if(indexTimeline)await (await import("../timeline/writers")).recordBundleTimeline(bundle,collectorFetched,root);
  return bundle;
}
export async function readBundle(connectionId: string, bundleId: string, root = findRepoRoot()): Promise<EvidenceBundle | null> {
  id(connectionId);
  if (!/^[a-f0-9]{64}$/.test(bundleId)) throw new Error("Invalid evidence ID.");
  const raw = await read(`${PREFIX}evidence/${connectionId}/${bundleId}.json`, root);
  if (!raw) return null;
  const bundle = verifyBundle(JSON.parse(raw), bundleId);
  if (bundle.connectionId !== connectionId) throw new Error("Evidence connection mismatch.");
  return bundle;
}
const MONITOR_KINDS = ["captures", "results", "timeline"] as const;
export type MonitorRecordKind = (typeof MONITOR_KINDS)[number];
function monitorDir(connectionId: string, kind: MonitorRecordKind): string {
  if (!MONITOR_KINDS.includes(kind)) throw new Error("Invalid monitoring record.");
  return `${PREFIX}monitoring/${id(connectionId)}/${kind}/`;
}
export function monitoringRecordKey(connectionId: string, kind: MonitorRecordKind, name: string): string {
  if (!/^[a-f0-9]{64}$/.test(name)) throw new Error("Invalid monitoring record.");
  return `${monitorDir(connectionId, kind)}${name}.json`;
}
/** Append-only monitoring bytes. A second write of the same hash is a replay, not an edit. */
export async function writeMonitoringRecord(connectionId: string, kind: MonitorRecordKind, name: string, body: string, root = findRepoRoot()): Promise<"created" | "exists"> {
  const max = kind === "timeline" ? 256_000 : 2_000_000;
  if (Buffer.byteLength(body) > max) throw new Error("Monitoring record exceeds the storage limit.");
  const key = monitoringRecordKey(connectionId, kind, name);
  const existing = await read(key, root);
  if (existing) {
    if (existing !== body) throw new Error("Monitoring record conflict.");
    return "exists";
  }
  const limit = kind === "timeline" ? 2000 : 500;
  if ((await keys(monitorDir(connectionId, kind), root)).length >= limit) throw new Error("Pilot monitoring limit reached; indexed storage is required.");
  try { await writeOnce(key, body, root); }
  catch (error) {
    const duplicate = await read(key, root);
    if (duplicate === body) return "exists";
    if (duplicate) throw new Error("Monitoring record conflict.");
    throw error;
  }
  return "created";
}
export async function readMonitoringRecord(connectionId: string, kind: MonitorRecordKind, name: string, root = findRepoRoot()): Promise<string | null> {
  return read(monitoringRecordKey(connectionId, kind, name), root);
}
export async function listMonitoringRecords(connectionId: string, kind: MonitorRecordKind, root = findRepoRoot()): Promise<string[]> {
  const files = await keys(monitorDir(connectionId, kind), root);
  return files.map(file => path.basename(file, ".json")).filter(name => /^[a-f0-9]{64}$/.test(name)).sort();
}

export async function listBundles(connectionId: string, root = findRepoRoot()): Promise<EvidenceBundle[]> {
  const files = await keys(`${PREFIX}evidence/${id(connectionId)}/`, root);
  if (files.length > 500) throw new Error("Pilot history limit reached; indexed storage is required.");
  const bundles = await Promise.all(files.map(file => readBundle(connectionId, path.basename(file, ".json"), root)));
  return bundles.filter((b): b is EvidenceBundle => !!b).sort((a, b) => Date.parse(b.event.run.observedAt) - Date.parse(a.event.run.observedAt) || b.receivedAt.localeCompare(a.receivedAt));
}

/** Local pull connection: no upload credential is issued or returned. */
export async function createPullConnection(name:string,owner:string,root=findRepoRoot(),github?:BuilderConnection["github"]){
 if(!owner||!/^[a-f0-9]{64}$/.test(owner)||!name.trim()||name.length>100)throw new Error("Invalid pull connection.");
 const connection:BuilderConnection={id:randomUUID(),name,...(github ? {github} : {}),ownerHash:sha256(owner),tokenHash:sha256(randomBytes(64)),createdAt:new Date().toISOString()};
 await writeOnce(connectionKey(connection.id),JSON.stringify(connection),root);
 await writeOnce(ownerKey(owner,connection.id),JSON.stringify({id:connection.id}),root);
 return connection;
}

/** Migration for legacy browser-owned pull connections; binding is immutable. */
export async function bindGithubConnection(connectionId: string, owner: string, github: NonNullable<BuilderConnection["github"]>) {
  const c = await readConnection(connectionId);
  if (!c || c.revokedAt || !ownsConnection(c, owner)) throw new Error("Connection unavailable.");
  if (c.github) {
    if (JSON.stringify(c.github) !== JSON.stringify(github)) throw new Error("Repository binding cannot change.");
    return c;
  }
  const url = `https://github.com/${github.owner}/${github.repo}`.toLowerCase();
  if ((await listBundles(connectionId)).some(b => b.event.subject.id.toLowerCase() !== url)) throw new Error("Legacy connection contains another repository.");
  await writeOnce(`${PREFIX}github-bindings/${id(connectionId)}.json`, JSON.stringify(github), findRepoRoot());
  return {...c, github};
}
