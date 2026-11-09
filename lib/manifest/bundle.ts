import {
  readFileSync,
  readdirSync,
  lstatSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { unzipSync, zipSync, strToU8 } from "fflate";
import {
  createManifest,
  verifyManifest,
  assertBundlePath,
  sha256,
  type BundleFile,
  type Manifest,
} from "./manifest";
import { documentModel, assertSchema } from "../oscal/validate-schema";
export function embeddedFiles(document: unknown): BundleFile[] {
  const files = new Map<string, BundleFile>();
  function visit(node: unknown, depth: number) {
    if (depth > 64) throw new Error("Embedded document depth exceeded.");
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const v of node) visit(v, depth + 1);
      return;
    }
    const obj = node as Record<string, unknown>,
      raw = obj.base64 as
        | { filename?: string; "media-type"?: string; value?: string }
        | undefined;
    if (raw && typeof raw.value === "string") {
      const bytes = Buffer.from(raw.value, "base64");
      if (bytes.toString("base64") !== raw.value)
        throw new Error("Invalid embedded bytes.");
      const name = `context/${sha256(bytes)}.json`,
        mediaType = raw["media-type"] ?? "application/octet-stream";
      let content: unknown;
      try {
        content = JSON.parse(bytes.toString("utf8"));
      } catch {
        content = null;
      }
      if (documentModel(content)) {
        assertSchema(content);
        files.set(name, {
          path: name,
          mediaType: "application/oscal+json",
          bytes,
        });
        visit(content, depth + 1);
      } else
        files.set(`evidence/${sha256(bytes)}`, {
          path: `evidence/${sha256(bytes)}`,
          mediaType,
          bytes,
        });
    }
    for (const [key, value] of Object.entries(obj))
      if (key !== "base64") visit(value, depth + 1);
  }
  visit(document, 0);
  return [...files.values()];
}
export function makeBundle(
  files: BundleFile[],
  sourceRuns: Manifest["sourceRuns"] = [],
  now = new Date(),
) {
  if (
    files.length > 999 ||
    files.some((f) => f.bytes.length > 20_000_000) ||
    files.reduce((sum, f) => sum + f.bytes.length, 0) > 79_000_000
  )
    throw new Error("Export bundle exceeds offline verification limits.");
  const manifest = createManifest(files, sourceRuns, now),
    members: Record<string, Uint8Array> = {};
  for (const file of files) members[file.path] = file.bytes;
  members["manifest.json"] = strToU8(JSON.stringify(manifest, null, 2));
  return { manifest, bytes: zipSync(members), files };
}
export function readBundleZip(bytes: Uint8Array): {
  manifest: Manifest;
  files: BundleFile[];
} {
  if (bytes.length > 30_000_000)
    throw new Error("Bundle exceeds compressed size limit.");
  let total = 0;
  const names = new Set<string>();
  const members = unzipSync(bytes, {
    filter: (file) => {
      if (file.name !== "manifest.json") assertBundlePath(file.name);
      if (names.has(file.name) || file.originalSize > 20_000_000)
        throw new Error("Duplicate or oversized bundle member.");
      names.add(file.name);
      total += file.originalSize;
      if (total > 80_000_000 || names.size > 1000)
        throw new Error("Bundle exceeds extraction limits.");
      return true;
    },
  });
  if (!members["manifest.json"]) throw new Error("Manifest missing.");
  const manifest = JSON.parse(
    Buffer.from(members["manifest.json"]).toString("utf8"),
  ) as Manifest;
  const files = Object.entries(members)
    .filter(([name]) => name !== "manifest.json")
    .map(([name, bytes]) => ({
      path: name,
      mediaType:
        manifest.artifacts?.find((a) => a.path === name)?.mediaType ??
        "application/octet-stream",
      bytes,
    }));
  return { manifest, files };
}
export function readBundleDirectory(dir: string) {
  const root = path.resolve(dir),
    files: BundleFile[] = [];
  let total = 0;
  if (lstatSync(path.join(root, "manifest.json")).isSymbolicLink())
    throw new Error("Symbolic links are not accepted in bundles.");
  const manifest = JSON.parse(
    readFileSync(path.join(root, "manifest.json"), "utf8"),
  ) as Manifest;
  function walk(relative: string) {
    for (const name of readdirSync(path.join(root, relative))) {
      const rel = relative ? relative + "/" + name : name;
      const stat = lstatSync(path.join(root, rel));
      if (stat.isSymbolicLink())
        throw new Error("Symbolic links are not accepted in bundles.");
      if (stat.isDirectory()) {
        walk(rel);
        continue;
      }
      if (rel === "manifest.json") continue;
      assertBundlePath(rel);
      total += stat.size;
      if (total > 80_000_000 || files.length >= 1000)
        throw new Error("Bundle exceeds size limits.");
      files.push({
        path: rel,
        mediaType:
          manifest.artifacts?.find((a) => a.path === rel)?.mediaType ??
          "application/octet-stream",
        bytes: readFileSync(path.join(root, rel)),
      });
    }
  }
  walk("");
  return { manifest, files };
}
export function verifyBundlePath(location: string, publicKey?: string) {
  const data = lstatSync(location).isDirectory()
    ? readBundleDirectory(location)
    : readBundleZip(readFileSync(location));
  return verifyManifest(data.manifest, data.files, publicKey);
}
export function writeBundleDirectory(
  dir: string,
  files: BundleFile[],
  sourceRuns: Manifest["sourceRuns"] = [],
  now = new Date(),
) {
  // Validate and sign everything before creating any output bytes.
  const manifest = createManifest(files, sourceRuns, now);
  mkdirSync(dir, { recursive: true });
  for (const file of files) {
    assertBundlePath(file.path);
    const target = path.join(dir, file.path);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, file.bytes, { flag: "wx", mode: 0o600 });
  }
  writeFileSync(
    path.join(dir, "manifest.json"),
    JSON.stringify(manifest, null, 2),
    { flag: "wx", mode: 0o600 },
  );
  return manifest;
}
