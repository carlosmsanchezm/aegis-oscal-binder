import path from "node:path";
import { randomUUID } from "node:crypto";
import { getSession } from "../aegis/store";
import { dataDir } from "../aegis/paths";
import { exportBlobKey } from "../storage-key";
import { persistenceMode, durableStorageConfigured } from "../durable";
import {
  retainBytes,
  flushRetainedWrites,
  readStoredBytesUnchecked,
} from "../retained-bytes";
import { embeddedFiles, makeBundle, readBundleZip } from "../manifest/bundle";
import { verifyManifest, type BundleFile } from "../manifest/manifest";
import { assertSchema } from "./validate-schema";
function bundleLocation(id: string) {
  const s = getSession();
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid export id.");
  const name = id + ".zip";
  return persistenceMode() === "blob"
    ? exportBlobKey(s.id, name)
    : path.join(dataDir(s.ctx.root), "sessions", s.id, "exports", name);
}
/** Preserve existing single-document downloads and expose their offline bundle via a response Link. */
export async function retainDocumentBundle(
  document: unknown,
  name: string,
  extra: BundleFile[] = [],
) {
  assertSchema(document);
  const files = [
    {
      path: name,
      mediaType: "application/oscal+json",
      bytes: Buffer.from(JSON.stringify(document, null, 2)),
    },
    ...embeddedFiles(document),
    ...extra,
  ];
  const result = makeBundle([
    ...new Map(files.map((f) => [f.path, f])).values(),
  ]);
  const id = durableStorageConfigured() ? randomUUID() : null;
  if (!id) return { id, manifest: result.manifest };
  retainBytes({
    location: bundleLocation(id),
    bytes: Buffer.from(result.bytes),
    contentType: "application/zip",
    label: "Export",
  });
  await flushRetainedWrites();
  return { id, manifest: result.manifest };
}
export async function readDocumentBundle(id: string) {
  const bytes = await readStoredBytesUnchecked(bundleLocation(id));
  if (!bytes) return null;
  const bundle = readBundleZip(bytes);
  if (verifyManifest(bundle.manifest, bundle.files).exitCode === 1)
    throw new Error("Stored export bundle failed verification.");
  return bytes;
}
