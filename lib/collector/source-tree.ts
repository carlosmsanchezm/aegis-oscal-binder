import { lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { collectEvidence } from "./collect";
import { collectorEvents } from "./events";
import type { EvidenceSource, GitEvidenceSource } from "./types";

/** Directory names the local checkout walker does not descend into. */
export const SKIPPED_DIRECTORIES = [".git", "node_modules", "vendor", ".venv", ".next", "dist"] as const;
export const MAX_SOURCE_BYTES = 2_000_000;

const SKIPPED = new Set<string>(SKIPPED_DIRECTORIES);

export function isSkippedDirectory(name: string): boolean {
  return SKIPPED.has(name);
}

export type SourceExclusion = { path: string; reason: string };
export type SourceEntryKind = "file" | "directory" | "symlink" | "submodule";
export type SourceEntry = { name: string; kind: SourceEntryKind };
export type SourcePin = {
  repo: string;
  commit: string;
  capturedAt: string;
  sourceKind?: GitEvidenceSource["sourceKind"];
  sourceUrl?: string;
};

export type SourceTree = {
  list(directory: string): Promise<readonly SourceEntry[]>;
  /** Null means the source did not report a size. The walker does not download it. */
  size(file: string): Promise<number | null>;
  read(file: string): Promise<Uint8Array>;
};

export type IndexedEntry = {
  path: string;
  kind: SourceEntryKind;
  size?: number | null;
};

export type SourceCapture = {
  source: { repo: string; commit: string; capturedAt: string };
  artifacts: ReturnType<typeof collectEvidence>;
  events: ReturnType<typeof collectorEvents>;
  excluded: SourceExclusion[];
};

export type SourceCaptureDocument = {
  schema: "aegis.source-capture.v1";
  captures: SourceCapture[];
};


/**
 * Depth-first inventory shared by a local checkout and a Git tree.
 * Sibling names sort with localeCompare, matching the historical CLI.
 */
export async function walkSourceTree(tree: SourceTree, pin: SourcePin): Promise<{ files: EvidenceSource[]; excluded: SourceExclusion[] }> {
  const files: EvidenceSource[] = [];
  const excluded: SourceExclusion[] = [];
  async function walk(directory: string): Promise<void> {
    const entries = [...await tree.list(directory)].sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const relative = directory ? `${directory}/${entry.name}` : entry.name;
      if (entry.kind === "symlink") {
        excluded.push({ path: relative, reason: "Symlink; not followed" });
        continue;
      }
      if (entry.kind === "submodule") {
        excluded.push({ path: relative, reason: "Git submodule; not followed" });
        continue;
      }
      if (entry.kind === "directory") {
        if (isSkippedDirectory(entry.name)) {
          excluded.push({ path: relative, reason: "Dependency, build or Git metadata directory" });
          continue;
        }
        await walk(relative);
        continue;
      }
      const size = await tree.size(relative);
      if (size === null) {
        excluded.push({ path: relative, reason: "Blob size unavailable; not downloaded" });
        continue;
      }
      if (size > MAX_SOURCE_BYTES) {
        excluded.push({ path: relative, reason: "Exceeds 2 MB source limit" });
        continue;
      }
      const bytes = Buffer.from(await tree.read(relative));
      if (bytes.length > MAX_SOURCE_BYTES) {
        excluded.push({ path: relative, reason: "Exceeds 2 MB source limit" });
        continue;
      }
      const content = bytes.toString("utf8");
      if (!bytes.equals(Buffer.from(content, "utf8"))) {
        excluded.push({ path: relative, reason: "Unsupported text encoding; original bytes not converted" });
        continue;
      }
      if (content.includes("\u0000")) {
        excluded.push({ path: relative, reason: "Binary source" });
        continue;
      }
      files.push({
        repo: pin.repo,
        commit: pin.commit,
        capturedAt: pin.capturedAt,
        path: relative,
        content,
        ...(pin.sourceKind ? { sourceKind: pin.sourceKind } : {}),
        ...(pin.sourceUrl ? { sourceUrl: pin.sourceUrl } : {}),
      });
    }
  }
  await walk("");
  return { files, excluded };
}

export function sourceCapture(files: EvidenceSource[], excluded: SourceExclusion[], source: SourcePin): SourceCapture {
  const artifacts = collectEvidence(files);
  const kept = new Set(artifacts.map((artifact) => artifact.source.path));
  const allExcluded = [
    ...excluded,
    ...files.filter((file) => !kept.has(file.path)).map((file) => ({ path: file.path, reason: "No supported evidence type; no content claims inferred" })),
  ];
  return {
    source: { repo: source.repo, commit: source.commit, capturedAt: source.capturedAt },
    artifacts,
    events: collectorEvents(artifacts),
    excluded: allExcluded,
  };
}

export function sourceCaptureDocument(captures: SourceCapture[]): SourceCaptureDocument {
  return { schema: "aegis.source-capture.v1", captures };
}

/** Working tree rooted at a clean checkout. Symlinks are reported and not followed. */
export function localSourceTree(root: string): SourceTree {
  const base = path.resolve(root);
  function resolveInside(relative: string): string {
    if (relative && relative.split("/").some((part) => part === "" || part === "." || part === "..")) {
      throw new Error("Use a relative source path.");
    }
    const abs = path.resolve(base, ...relative.split("/").filter(Boolean));
    if (abs !== base && !abs.startsWith(base + path.sep)) throw new Error("Use a relative source path.");
    return abs;
  }
  return {
    async list(directory: string) {
      return readdirSync(resolveInside(directory), { withFileTypes: true }).map((entry) => ({
        name: entry.name,
        kind: entry.isSymbolicLink() ? "symlink" as const : entry.isDirectory() ? "directory" as const : "file" as const,
      }));
    },
    async size(file: string) {
      return lstatSync(resolveInside(file)).size;
    },
    async read(file: string) {
      return readFileSync(resolveInside(file));
    },
  };
}

/** Flat Git tree entries. Parent directories are synthesized so the walker can skip them. */
export function indexedSourceTree(entries: readonly IndexedEntry[], read: (file: string) => Promise<Uint8Array>): SourceTree {
  type Node = { name: string; kind: SourceEntryKind; size: number | null; path: string };
  const children = new Map<string, Node[]>();
  const ensure = (directory: string) => {
    if (!children.has(directory)) children.set(directory, []);
  };
  const add = (directory: string, node: Node) => {
    ensure(directory);
    const list = children.get(directory)!;
    const existing = list.find((item) => item.name === node.name);
    if (!existing) {
      list.push(node);
      return;
    }
    if (existing.kind === "directory" && node.kind !== "directory") {
      existing.kind = node.kind;
      existing.size = node.size;
      existing.path = node.path;
    }
  };
  ensure("");
  for (const entry of entries) {
    const parts = entry.path.split("/");
    let directory = "";
    for (let index = 0; index < parts.length - 1; index += 1) {
      const name = parts[index]!;
      const pathName = directory ? `${directory}/${name}` : name;
      add(directory, { name, kind: "directory", size: null, path: pathName });
      directory = pathName;
      ensure(directory);
    }
    const name = parts[parts.length - 1]!;
    add(directory, { name, kind: entry.kind, size: entry.size ?? null, path: entry.path });
    if (entry.kind === "directory") ensure(entry.path);
  }
  const lookup = (file: string): Node | null => {
    const slash = file.lastIndexOf("/");
    const directory = slash === -1 ? "" : file.slice(0, slash);
    const name = slash === -1 ? file : file.slice(slash + 1);
    return (children.get(directory) ?? []).find((item) => item.name === name) ?? null;
  };
  return {
    async list(directory: string) {
      return (children.get(directory) ?? []).map((item) => ({ name: item.name, kind: item.kind }));
    },
    async size(file: string) {
      const node = lookup(file);
      if (!node || node.kind !== "file") return null;
      return node.size;
    },
    async read(file: string) {
      return read(file);
    },
  };
}
