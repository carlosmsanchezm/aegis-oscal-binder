import path from "node:path";
import type { StoredFile, FileComparison } from "./digest-model";
import { getPackageState } from "./aegis/derive";
import { AegisError } from "./aegis/errors";
import { sha256Bytes } from "./aegis/hash";
import { exportOscal, validateOscal } from "./aegis/operations";
import { outDir } from "./aegis/store";
import { packageDocx, packageXlsx, renderExcelSheets, renderWordXml } from "./aegis/render";
import type { Ctx, KeptObject, PersistedState } from "./aegis/types";
import {
  DIGEST_CHECK_NOTE,
  digestObjectKey,
  readDigestCheck,
  storedObjectName,
  writeDigestCheck,
  type StoredDigestCheck,
} from "./digest-audit";
import { PREVIEW_STORE_REFUSED, persistenceMode, storageUnconfigured } from "./durable";
import {
  flushRetainedWrites,
  locateWorkspaceEvidence,
  readRetained,
  readStoredBytesUnchecked,
  retainBytes,
} from "./retained-bytes";
import { exportBlobKey } from "./storage-key";
import { serializeOscal } from "./aegis/oscal";

export type DigestCheckResult = StoredDigestCheck & { note: string };

export type RegeneratedExport = {
  kind: "export";
  exportId: string;
  render: "oscal" | "word" | "excel";
  objectName: string;
  objectKey: string;
  sha256: string;
  source: "export record" | "package state";
  priorObjectName: string;
  priorObjectKey: string;
  priorRecordedDigest: string | null;
  priorRecomputedDigest: string | null;
  keptPriorBytes: boolean;
  validatorStatus?: "GREEN" | "RED";
};

const STORE_UNAVAILABLE_MESSAGE =
  "Evidence and exports need durable storage on Vercel. Set BLOB_READ_WRITE_TOKEN or AEGIS_DATA_DIR. The instance directory is not used.";

function requireDurable(): void {
  try {
    persistenceMode();
  } catch (error) {
    if (storageUnconfigured(error)) throw new AegisError("STORE_UNAVAILABLE", STORE_UNAVAILABLE_MESSAGE, 503);
    if (error instanceof Error && error.message === PREVIEW_STORE_REFUSED) {
      throw new AegisError("STORE_UNAVAILABLE", error.message, 503);
    }
    throw error;
  }
}

function requireOwner(ctx: Ctx): string {
  if (!ctx.ownerKey || !/^[a-f0-9]{32}$/.test(ctx.ownerKey)) {
    throw new AegisError("BAD_REQUEST", "A session is required.", 400);
  }
  return ctx.ownerKey;
}

type Target = {
  location: string; expected: string | undefined; label: "Evidence file" | "Export"; file: StoredFile;
};

function targetsFor(state: PersistedState, ctx: Ctx): Target[] {
  const targets: Target[] = [];
  const seen = new Set<string>();
  function add(location: string | undefined, expected: string | undefined, file: Omit<StoredFile, "objectKey" | "objectName" | "recordedDigest">) {
    if (!location || seen.has(location)) return;
    seen.add(location);
    targets.push({ location, expected, label: file.kind === "evidence" ? "Evidence file" : "Export", file: {
      ...file, objectKey: digestObjectKey(location), objectName: storedObjectName(location), recordedDigest: expected ?? null,
    } });
  }
  for (const control of state.controls) for (const item of control.evidence) {
    if (!item.href.startsWith("workspace-evidence/")) continue;
    add(locateWorkspaceEvidence(ctx.root, item.href, ctx.ownerKey) ?? undefined, item.sha256, {
      kind: "evidence", storedAt: item.storedAt ?? null, controlId: control.id, evidenceId: item.id, title: item.title,
      filename: storedObjectName(item.href).replace(/^[a-f0-9-]{36}-/, ""),
    });
  }
  for (const item of state.exports) {
    const file = { kind: "export" as const, storedAt: item.at, exportId: item.id, render: "oscal" as const };
    const replacement = state.exports.find(candidate => candidate.regeneratedFrom === item.id);
    add(item.filePath, item.sha256, replacement ? { ...file, kept: true, keptAt: replacement.at, replacementObjectKey: digestObjectKey(replacement.filePath) } : file);
    for (const prior of item.priorObjects ?? []) add(prior.filePath, prior.sha256, { ...file, kept: true, keptAt: prior.keptAt });
  }
  for (const render of [state.renders.word, state.renders.excel]) {
    if (!render) continue;
    const file = { kind: "export" as const, storedAt: render.at, exportId: render.exportId, render: render.kind };
    add(render.filePath, render.sha256, file);
    for (const prior of render.priorObjects ?? []) add(prior.filePath, prior.sha256, { ...file, kept: true, keptAt: prior.keptAt });
  }
  return targets;
}

export function storedFileInventory(state: PersistedState, ctx: Ctx): StoredFile[] {
  requireDurable();
  requireOwner(ctx);
  return targetsFor(state, ctx).map(target => target.file);
}

/** Recompute SHA 256 for every stored evidence file and export in this package. */
export async function verifyStoredDigests(state: PersistedState, ctx: Ctx): Promise<DigestCheckResult> {
  requireDurable();
  const owner = requireOwner(ctx);
  let matched = 0;
  let mismatched = 0;
  let skipped = 0;
  const files: FileComparison[] = [];
  for (const target of targetsFor(state, ctx)) {
    if (!target.expected) {
      skipped += 1;
      files.push({ ...target.file, result: "unverified", recomputedDigest: null });
      continue;
    }
    try {
      const bytes = await readRetained(target.location, target.expected, target.label, {
        ownerKey: owner,
        bypassCache: true,
      });
      if (!bytes) { skipped += 1; files.push({ ...target.file, result: "unreadable", recomputedDigest: null }); }
      else { matched += 1; files.push({ ...target.file, result: "match", recomputedDigest: sha256Bytes(bytes) }); }
    } catch (error) {
      if (error instanceof AegisError && error.code === "DIGEST_MISMATCH") {
        mismatched += 1;
        files.push({ ...target.file, result: "mismatch", recomputedDigest: (error.details as { recomputedDigest: string }).recomputedDigest });
        continue;
      }
      skipped += 1;
      files.push({ ...target.file, result: "unreadable", recomputedDigest: null });
    }
  }
  const check: StoredDigestCheck = {
    files,
    matched,
    mismatched,
    skipped,
    checkedAt: new Date().toISOString(),
  };
  await writeDigestCheck(owner, check);
  return { ...check, note: DIGEST_CHECK_NOTE };
}

export async function lastDigestCheck(ctx: Ctx): Promise<DigestCheckResult | null> {
  requireDurable();
  const owner = requireOwner(ctx);
  const stored = await readDigestCheck(owner);
  if (!stored) return null;
  return { ...stored, note: DIGEST_CHECK_NOTE };
}

function versionName(filename: string, version: number): string {
  const dot = filename.lastIndexOf(".");
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  const ext = dot > 0 ? filename.slice(dot) : "";
  return `${stem}.v${version}${ext}`;
}

function ownerFromBlob(location: string): string | null {
  const match = /^aegis\/sessions\/([a-f0-9]{32})\//.exec(location);
  return match?.[1] ?? null;
}

async function nextLocation(location: string, startVersion: number, owner: string): Promise<string> {
  for (let version = startVersion; version < startVersion + 50; version += 1) {
    const filename = versionName(storedObjectName(location), version);
    const next = location.startsWith("aegis/")
      ? exportBlobKey(ownerFromBlob(location) ?? owner, filename)
      : path.join(path.dirname(location), filename);
    if (next === location) continue;
    const existing = await readStoredBytesUnchecked(next);
    if (!existing) return next;
  }
  throw new AegisError("REGENERATE_UNAVAILABLE", "No new object version could be stored.", 409);
}

function contentTypeFor(render: RegeneratedExport["render"]): string {
  if (render === "word") return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (render === "excel") return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  return "application/xml";
}

async function writeVersion(
  owner: string,
  currentPath: string,
  recordedDigest: string | undefined,
  bytes: Buffer,
  render: RegeneratedExport["render"],
  priorCount: number,
): Promise<{ filePath: string; sha256: string; prior: KeptObject | null; priorObjectKey: string }> {
  const existing = currentPath ? await readStoredBytesUnchecked(currentPath) : null;
  const recomputed = existing ? sha256Bytes(existing) : null;
  if (existing && recordedDigest && recomputed === recordedDigest.toLowerCase()) {
    throw new AegisError("REGENERATE_UNNEEDED", "Stored bytes match the recorded digest.", 409);
  }
  const prior = currentPath
    ? {
        filePath: currentPath,
        sha256: recordedDigest,
        recomputedDigest: recomputed,
        keptAt: new Date().toISOString(),
      }
    : null;
  const filePath = await nextLocation(currentPath, priorCount + 2, owner);
  const retained = retainBytes({
    location: filePath,
    bytes,
    contentType: contentTypeFor(render),
    label: "Export",
  });
  await flushRetainedWrites();
  return {
    filePath,
    sha256: retained.sha256,
    prior,
    priorObjectKey: currentPath ? digestObjectKey(currentPath) : "",
  };
}

function regeneratedFrom(
  exportId: string,
  render: RegeneratedExport["render"],
  source: RegeneratedExport["source"],
  filePath: string,
  sha256: string,
  prior: KeptObject | null,
  priorObjectKey: string,
): RegeneratedExport {
  return {
    kind: "export",
    exportId,
    render,
    objectName: storedObjectName(filePath),
    objectKey: digestObjectKey(filePath),
    sha256,
    source,
    priorObjectName: prior ? storedObjectName(prior.filePath) : "",
    priorObjectKey,
    priorRecordedDigest: prior?.sha256 ?? null,
    priorRecomputedDigest: prior?.recomputedDigest ?? null,
    keptPriorBytes: Boolean(prior && prior.recomputedDigest),
  };
}

function sheetsOf(controls: Parameters<typeof renderExcelSheets>[0], title: string): [string, string] {
  const sheets = renderExcelSheets(controls, title);
  return [sheets.controls, sheets.evidence];
}

function assertGreen(state: PersistedState, ctx: Ctx): ReturnType<typeof getPackageState> {
  const pkg = getPackageState(state, ctx);
  if (pkg.gate.status !== "PASS" || pkg.pipeline.validator.status !== "GREEN") {
    throw new AegisError("VALIDATOR_LOCKED", "Locked until validator GREEN", 409, {
      validator: pkg.pipeline.validator,
    });
  }
  return pkg;
}

export async function regenerateStoredExport(
  state: PersistedState,
  ctx: Ctx,
  request: { exportId: string; newExport?: boolean } | { render: "word" | "excel" },
): Promise<{ state: PersistedState; regenerated: RegeneratedExport }> {
  requireDurable();
  const owner = requireOwner(ctx);
  const next = structuredClone(state);
  if ("exportId" in request) {
    const record = next.exports.find((item) => item.id === request.exportId);
    if (!record) throw new AegisError("NOT_FOUND", "No stored export matches that id.", 404);
    if (!request.newExport) {
      // Preserve the existing PR 54 API contract unless the caller explicitly
      // requests the M1 current package export operation.
      const xml = record.xml?.length ? record.xml : serializeOscal(next, { now: new Date(record.at), defects: false });
      if (!xml) throw new AegisError("REGENERATE_UNAVAILABLE", "The package record has no export text to write again.", 409);
      const written = await writeVersion(owner, record.filePath, record.sha256, Buffer.from(xml, "utf8"), "oscal", record.priorObjects?.length ?? 0);
      if (written.prior) record.priorObjects = [...(record.priorObjects ?? []), written.prior];
      record.filePath = written.filePath;
      record.sha256 = written.sha256;
      return { state: next, regenerated: regeneratedFrom(record.id, "oscal", record.xml?.length ? "export record" : "package state", written.filePath, written.sha256, written.prior, written.priorObjectKey) };
    }
    const existing = await readStoredBytesUnchecked(record.filePath);
    const recomputed = existing ? sha256Bytes(existing) : null;
    if (existing && record.sha256 && recomputed === record.sha256.toLowerCase()) {
      throw new AegisError("REGENERATE_UNNEEDED", "Stored bytes match the recorded digest.", 409);
    }
    const prior: KeptObject = { filePath: record.filePath, sha256: record.sha256, recomputedDigest: recomputed, keptAt: new Date().toISOString() };
    const exported = exportOscal(next, { ...ctx, outDir: outDir(ctx.root, owner) });
    exported.state.exports.at(-1)!.regeneratedFrom = record.id;
    await flushRetainedWrites();
    const validated = validateOscal(exported.state, ctx);
    return {
      state: validated.state,
      regenerated: { ...regeneratedFrom(exported.exportId, "oscal", "package state", exported.filePath,
        exported.state.exports.at(-1)!.sha256!, prior, digestObjectKey(record.filePath)), validatorStatus: validated.validation.status },
    };
  }

  const pkg = assertGreen(next, ctx);
  const render = request.render === "word" ? next.renders.word : next.renders.excel;
  if (!render?.filePath) {
    const message = request.render === "word" ? "Word render has not been written." : "Excel render has not been written.";
    throw new AegisError("NOT_FOUND", message, 404);
  }
  const title = next.workspaceName ?? "OSCAL binder";
  const bytes = request.render === "word"
    ? packageDocx(renderWordXml(pkg.controls, title))
    : packageXlsx(...sheetsOf(pkg.controls, title));
  const written = await writeVersion(owner, render.filePath, render.sha256, bytes, request.render, render.priorObjects?.length ?? 0);
  if (written.prior) render.priorObjects = [...(render.priorObjects ?? []), written.prior];
  render.filePath = written.filePath;
  render.sha256 = written.sha256;
  return {
    state: next,
    regenerated: regeneratedFrom(render.exportId, request.render, "package state", written.filePath, written.sha256, written.prior, written.priorObjectKey),
  };
}

/** A fresh comparison for one owned physical file, without an audit or full pass write. */
export async function compareStoredFile(state: PersistedState, ctx: Ctx, objectKey: string): Promise<FileComparison> {
  requireDurable();
  const owner = requireOwner(ctx);
  if (!/^[a-f0-9]{64}$/.test(objectKey)) throw new AegisError("BAD_REQUEST", "Object key must be 64 hex characters.", 400);
  const target = targetsFor(state, ctx).find(item => item.file.objectKey === objectKey);
  if (!target) throw new AegisError("NOT_FOUND", "No stored file matches that object.", 404);
  if (!target.expected) return { ...target.file, result: "unverified", recomputedDigest: null };
  try {
    const bytes = await readRetained(target.location, target.expected, target.label, { ownerKey: owner, bypassCache: true, recordAudit: false });
    return { ...target.file, result: bytes ? "match" : "unreadable", recomputedDigest: bytes ? sha256Bytes(bytes) : null };
  } catch (error) {
    if (error instanceof AegisError && error.code === "DIGEST_MISMATCH") return { ...target.file, result: "mismatch", recomputedDigest: (error.details as { recomputedDigest: string }).recomputedDigest };
    return { ...target.file, result: "unreadable", recomputedDigest: null };
  }
}
