import { randomUUID } from "node:crypto";
import path from "node:path";
import { appendLog, readLog } from "../immutable-log";
import { storageKey } from "../storage-key";
import { dataDir, findRepoRoot } from "../aegis/paths";
import { persistenceMode } from "../durable";
import {
  retainBytes,
  flushRetainedWrites,
  readStoredBytesUnchecked,
} from "../retained-bytes";
import { readBundleZip } from "../manifest/bundle";
import { sha256, verifyManifest, type Manifest } from "../manifest/manifest";
export type ExportRecord = {
  id: string;
  connectionId: string;
  createdAt: string;
  manifest: Manifest;
  bundleSha256: string;
};
function prefix(connectionId: string) {
  if (!/^[a-f0-9-]{36}$/.test(connectionId))
    throw new Error("Invalid connection id.");
  return storageKey(["connection-exports", connectionId]) + "/";
}
function recordKey(connectionId: string, id: string) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid export id.");
  return prefix(connectionId) + id + ".json";
}
function location(connectionId: string, id: string) {
  const key = recordKey(connectionId, id).replace(/\.json$/, ".zip");
  return persistenceMode() === "blob"
    ? key
    : path.join(dataDir(findRepoRoot()), key);
}
export async function retainConnectionExport(
  connectionId: string,
  bundle: { bytes: Uint8Array; manifest: Manifest },
) {
  const id = randomUUID(),
    record: ExportRecord = {
      id,
      connectionId,
      createdAt: bundle.manifest.createdAt,
      manifest: bundle.manifest,
      bundleSha256: sha256(bundle.bytes),
    };
  retainBytes({
    location: location(connectionId, id),
    bytes: Buffer.from(bundle.bytes),
    contentType: "application/zip",
    label: "Export",
  });
  await flushRetainedWrites();
  await appendLog(prefix(connectionId), record, (r) => r.id === id);
  return record;
}
export async function listConnectionExports(connectionId: string) {
  return (await readLog<ExportRecord>(prefix(connectionId)))
    .map((e) => e.body)
    .reverse();
}
export async function readConnectionExport(connectionId: string, id: string) {
  if (!/^[a-f0-9-]{36}$/.test(id)) return null;
  return (
    (await listConnectionExports(connectionId)).find(
      (record) => record.connectionId === connectionId && record.id === id,
    ) ?? null
  );
}
async function inspectExport(record: ExportRecord) {
  const invalid = (message: string) => ({
    bytes: null,
    verification: {
      status: "invalid" as const,
      exitCode: 1 as const,
      errors: [message],
    },
  });
  try {
    const bytes = await readStoredBytesUnchecked(
      location(record.connectionId, record.id),
    );
    if (!bytes || sha256(bytes) !== record.bundleSha256)
      return invalid("Retained export bytes are missing or changed.");
    const bundle = readBundleZip(bytes);
    if (JSON.stringify(bundle.manifest) !== JSON.stringify(record.manifest))
      return invalid("Retained manifest differs from export history.");
    const verification = verifyManifest(bundle.manifest, bundle.files);
    return { bytes, verification };
  } catch {
    return invalid("Retained export could not be verified.");
  }
}
export async function verifyConnectionExport(record: ExportRecord) {
  return (await inspectExport(record)).verification;
}
export async function readConnectionExportBytes(record: ExportRecord) {
  const { bytes, verification } = await inspectExport(record);
  if (verification.exitCode === 1)
    throw new Error("Retained export failed verification.");
  return bytes;
}
