import {makeBundle,embeddedFiles} from "../manifest/bundle";
import {assertSchema} from "../oscal/validate-schema";
import {locateWorkspaceEvidence,readRetainedSync} from "../retained-bytes";
import {resolveEvidenceHref} from "./paths";
import type {BundleFile} from "../manifest/manifest";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { pinForCatalog, requireCatalogId } from "./catalogs";
import { FIXTURE_ID } from "./constants";
import { getChanges } from "./changes";
import { getPackageState } from "./derive";
import { AegisError } from "./errors";
import {
  newEvidenceUuid,
  nextEvidenceId,
  requireEvidence,
  resolveRole,
} from "./evidence";
import { cloneControls, readGoldFixture } from "./fixture";
import { dataDir } from "./paths";
import { hashControls, oscalArtifactFilename, padId } from "./hash";
import { discardRetained, readVerified, retainBytes } from "../retained-bytes";
import { evidenceBlobKey, exportBlobKey } from "../storage-key";
import { persistenceMode, PREVIEW_STORE_REFUSED, storageUnconfigured } from "../durable";
import { serializeOscal, validateOscalXml, validationStatus } from "./oscal";
import { isResolvedModerateProfile } from "./profile-resolution";
import { buildPackageSsp, validatePackageSsp } from "./ssp-export";
import { packageDocx, packageXlsx, renderExcelSheets, renderWordXml, spotCheckParity } from "./render";
import { roleIdsOf } from "./derive";
import { mappingDecision, type ArtifactMappingProposal } from "./artifact-mapping";
import type { PipelineEvidence } from "./pipeline-evidence";
import type {
  ChangesReport,
  ControlRecord,
  Ctx,
  EvidenceInput,
  PackageState,
  PersistedState,
  ValidationRecord,
} from "./types";

export function emptyPersisted(): PersistedState {
  return {
    version: 1,
    loaded: false,
    workspaceName: null,
    boundaryId: null,
    catalogPin: null,
    catalogId: null,
    ingestKind: null,
    sourceFilename: null,
    sourceProfileHref: null,
    roles: [],
    controls: [],
    exports: [],
    lastValidation: null,
    renders: { word: null, excel: null },
    parity: null,
    baseline: null,
    blockedAttempts: [],
    pipelineMappingDecisions: [],
    counters: { export: 0, baseline: 0, attempt: 0 },
  };
}

function nowOf(ctx: Ctx): Date {
  return (ctx.now ?? (() => new Date()))();
}

function clone(state: PersistedState): PersistedState {
  return structuredClone(state);
}

function requireLoaded(state: PersistedState): void {
  if (!state.loaded) throw new AegisError("NO_FIXTURE", "Load an OSCAL package or the demo sample package first.", 400);
}

function findControl(state: PersistedState, controlId: string): ControlRecord {
  const control = state.controls.find((item) => item.id === controlId);
  if (!control) throw new AegisError("CONTROL_NOT_FOUND", `Unknown control ${controlId}`, 404);
  return control;
}

export function loadFixture(state: PersistedState, fixtureId: string, ctx: Ctx): PersistedState {
  if (fixtureId !== FIXTURE_ID) {
    throw new AegisError("UNKNOWN_FIXTURE", 'Only fixture "gold" is available.', 400);
  }
  const fixture = readGoldFixture(ctx.root);
  const next = emptyPersisted();
  // Canned demo bootstrap for boundary bnd-gold-0001. Not an authorization claim.
  next.loaded = true;
  next.workspaceName = fixture.workspaceName;
  next.boundaryId = fixture.boundaryId;
  next.catalogPin = fixture.catalogPin;
  next.catalogId = "fedramp-rev5";
  next.ingestKind = "gold";
  next.sourceFilename = "fixtures/gold/fixture.json";
  next.sourceProfileHref = null;
  next.roles = structuredClone(fixture.roles);
  next.controls = cloneControls(fixture.controls);
  next.pipelineMappingDecisions = structuredClone(state.pipelineMappingDecisions ?? []);
  return next;
}

export type ControlPatch = {
  implementation?: string;
  responsibleRole?: string;
  /** Pipe-separated role titles or ids. When set, replaces the whole role list. */
  responsibleRoles?: string;
};

function applyRoleList(control: ControlRecord, ids: string[]): void {
  control.responsibleRoleIds = ids;
  control.responsibleRoleId = ids[0] ?? "";
}

function applyPatch(control: ControlRecord, patch: ControlPatch, roles: PersistedState["roles"]): void {
  if (patch.implementation !== undefined) control.implementation = patch.implementation.trim();
  if (patch.responsibleRoles !== undefined) {
    const raw = patch.responsibleRoles.split("|").map((item) => item.trim()).filter(Boolean);
    const ids: string[] = [];
    for (const value of raw) {
      const role = resolveRole(roles, value);
      if (!role) throw new AegisError("UNKNOWN_ROLE", `Unknown responsible role "${value}"`, 400);
      if (!ids.includes(role.id)) ids.push(role.id);
    }
    applyRoleList(control, ids);
    return;
  }
  if (patch.responsibleRole !== undefined) {
    const raw = patch.responsibleRole.trim();
    if (!raw) {
      applyRoleList(control, []);
      return;
    }
    const role = resolveRole(roles, raw);
    if (!role) throw new AegisError("UNKNOWN_ROLE", `Unknown responsible role "${raw}"`, 400);
    const rest = roleIdsOf(control).filter((id) => id !== role.id);
    applyRoleList(control, [role.id, ...rest]);
  }
}

export function updateControl(state: PersistedState, controlId: string, patch: ControlPatch, ctx: Ctx): PersistedState {
  requireLoaded(state);
  void ctx;
  const next = clone(state);
  const control = findControl(next, controlId);
  applyPatch(control, patch, next.roles);
  return next;
}

function storedDigest(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const digest = value.trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(digest) ? digest : undefined;
}

function blobOwner(ownerKey: string | undefined): string | null {
  if (!ownerKey || !/^[a-f0-9]{32}$/.test(ownerKey)) return null;
  try {
    return persistenceMode() === "blob" ? ownerKey : null;
  } catch (error) {
    if (storageUnconfigured(error)) {
      throw new AegisError(
        "STORE_UNAVAILABLE",
        "Evidence and exports need durable storage on Vercel. Set BLOB_READ_WRITE_TOKEN or AEGIS_DATA_DIR. The instance directory is not used.",
        503,
      );
    }
    if (error instanceof Error && error.message === PREVIEW_STORE_REFUSED) {
      throw new AegisError("STORE_UNAVAILABLE", error.message, 503);
    }
    throw error;
  }
}

export function addEvidence(state: PersistedState, controlId: string, input: EvidenceInput, ctx: Ctx): PersistedState {
  requireLoaded(state);
  const next = clone(state);
  const control = findControl(next, controlId);
  const accepted = requireEvidence(control, input, ctx);
  const sha256 = storedDigest(input.sha256);
  control.evidence.push({
    id: nextEvidenceId(control),
    title: accepted.title,
    type: accepted.type,
    href: accepted.href,
    uuid: newEvidenceUuid(),
    ...(sha256 ? { sha256 } : {}),
  });
  return next;
}

export function updateEvidence(
  state: PersistedState,
  controlId: string,
  evidenceId: string,
  input: EvidenceInput,
  ctx: Ctx,
): PersistedState {
  requireLoaded(state);
  const next = clone(state);
  const control = findControl(next, controlId);
  const evidence = control.evidence.find((item) => item.id === evidenceId);
  if (!evidence) throw new AegisError("EVIDENCE_NOT_FOUND", `Unknown evidence ${evidenceId}`, 404);
  const accepted = requireEvidence(control, input, ctx, evidenceId);
  const sameHref = accepted.href === evidence.href;
  evidence.title = accepted.title;
  evidence.type = accepted.type;
  evidence.href = accepted.href;
  if (!sameHref) {
    delete evidence.storedAt;
    const sha256 = storedDigest(input.sha256);
    if (sha256) evidence.sha256 = sha256;
    else delete evidence.sha256;
  }
  return next;
}

export function saveControl(
  state: PersistedState,
  controlId: string,
  input: ControlPatch & { evidence?: EvidenceInput | null },
  ctx: Ctx,
): PersistedState {
  requireLoaded(state);
  const draft = input.evidence;
  const hasDraft = Boolean(draft && (draft.title.trim() || draft.type.trim() || draft.href.trim()));
  if (hasDraft && draft) {
    const control = findControl(state, controlId);
    requireEvidence(control, draft, ctx);
  }
  let next = updateControl(state, controlId, input, ctx);
  if (hasDraft && draft) next = addEvidence(next, controlId, draft, ctx);
  return next;
}

function requireComplete(state: PersistedState, ctx: Ctx): PackageState {
  requireLoaded(state);
  const pkg = getPackageState(state, ctx);
  if (pkg.gate.status !== "PASS") {
    throw new AegisError(
      "GATE_FAIL",
      "Word, Excel, and baseline stay locked until completeness is PASS and the validator is GREEN.",
      409,
      { gate: pkg.gate },
    );
  }
  return pkg;
}

export type ExportSuccess = {
  state: PersistedState;
  xml: string;
  filePath: string;
  filename: string;
  exportId: string;
  packageState: PackageState;
  bundlePath: string;
};

export function exportOscal(state: PersistedState, ctx: Ctx & { outDir: string }): ExportSuccess {
  const pkg = getPackageState(state, ctx);
  if (!state.loaded || pkg.gate.status === "EMPTY") {
    throw new AegisError("NO_FIXTURE", "Load an OSCAL package or the demo sample package first.", 400);
  }

  const at = nowOf(ctx);
  const jsonSsp=buildPackageSsp(state,at);
  assertSchema(jsonSsp,"system-security-plan",ctx.root);
  const xml = serializeOscal(state, { now: at, defects: false });
  const next = clone(state);
  const exportNumber = next.counters.export + 1;
  next.counters.export = exportNumber;
  const exportId = padId("exp", exportNumber);
  const filename = oscalArtifactFilename(exportId);
  const owner = blobOwner(ctx.ownerKey);
  const filePath = owner ? exportBlobKey(owner, filename) : path.join(ctx.outDir, filename);
  const files:BundleFile[]=[{path:filename,mediaType:"application/xml",bytes:Buffer.from(xml)},{path:"system-security-plan.json",mediaType:"application/oscal+json",bytes:Buffer.from(JSON.stringify(jsonSsp,null,2))},...embeddedFiles(jsonSsp)];
  for(const evidence of state.controls.flatMap(c=>c.evidence)){
    const location=locateWorkspaceEvidence(ctx.root,evidence.href,ctx.ownerKey)??resolveEvidenceHref(ctx.root,evidence.href);
    if(!location)continue;const bytes=readRetainedSync(location,evidence.sha256,"Evidence file",{ownerKey:ctx.ownerKey});
    if(bytes)files.push({path:`evidence/${evidence.uuid}`,mediaType:"application/octet-stream",bytes});
  }
  const bundle=makeBundle([...new Map(files.map(f=>[f.path,f])).values()],[],at);
  const bundlePath=owner?exportBlobKey(owner,filename+".bundle.zip"):path.join(ctx.outDir,filename+".bundle.zip");
  const retained = retainBytes({ location: filePath, bytes: Buffer.from(xml, "utf8"), contentType: "application/xml", label: "Export" });
  retainBytes({location:bundlePath,bytes:Buffer.from(bundle.bytes),contentType:"application/zip",label:"Export"});
  next.exports.push({
    id: exportId,
    at: at.toISOString(),
    irHash: hashControls(next.controls),
    filename,
    filePath,
    sha256: retained.sha256,
    xml,
  });
  return { state: next, xml, filePath, filename, exportId, bundlePath, packageState: getPackageState(next, ctx) };
}

/** XML for the latest export. The file is preferred; the session copy is used when the file is gone. */
export function exportedOscalXml(state: PersistedState, ctx: Ctx): string {
  const last = state.exports.at(-1);
  if (!last) {
    throw new AegisError("NOT_FOUND", "package-oscal.xml has not been written.", 404);
  }
  if (last.filePath) {
    const bytes = readVerifiedOrMissing(last.filePath, last.sha256, ctx.ownerKey);
    if (bytes) return bytes.toString("utf8");
  }
  if (last.xml) return last.xml;
  return serializeOscal(state, { now: new Date(last.at), defects: false });
}

function requireFreshExport(state: PersistedState, ctx: Ctx): { pkg: PackageState; xml: string; exportId: string } {
  requireLoaded(state);
  const pkg = getPackageState(state, ctx);
  const last = state.exports.at(-1);
  if (!last || last.irHash !== pkg.irHash) {
    throw new AegisError(
      "EXPORT_STALE",
      "Re export before validation. The written OSCAL does not match the current IR.",
      409,
    );
  }
  const xml = exportedOscalXml(state, ctx);
  return { pkg, xml, exportId: last.id };
}

export function validateOscal(
  state: PersistedState,
  ctx: Ctx,
  scenario: "current" | "red" = "current",
): { state: PersistedState; validation: ValidationRecord; packageState: PackageState; xml: string } {
  const fresh = requireFreshExport(state, ctx);
  const xml = scenario === "red" ? serializeOscal(state, { now: nowOf(ctx), defects: true }) : fresh.xml;
  const errors = validateOscalXml(xml, state);
  const status = validationStatus(errors);
  if (scenario === "red" && status === "GREEN") {
    throw new AegisError("RED_EXPECTED", "RED sample did not produce named errors.", 500);
  }
  const validation: ValidationRecord = {
    status,
    errors,
    at: nowOf(ctx).toISOString(),
    irHash: fresh.pkg.irHash!,
    exportId: fresh.exportId,
    scenario,
  };
  const next = clone(state);
  next.lastValidation = validation;
  return { state: next, validation, packageState: getPackageState(next, ctx), xml };
}

function requireGreen(state: PersistedState, ctx: Ctx): PackageState {
  const pkg = requireComplete(state, ctx);
  if (pkg.pipeline.validator.status !== "GREEN") {
    throw new AegisError("VALIDATOR_LOCKED", "Locked until validator GREEN", 409, {
      validator: pkg.pipeline.validator,
    });
  }
  return pkg;
}

function refreshParity(state: PersistedState, ctx: Ctx, oscalXml: string): void {
  const pkg = getPackageState(state, ctx);
  if (!state.renders.word || !state.renders.excel) return;
  if (state.renders.word.irHash !== pkg.irHash || state.renders.excel.irHash !== pkg.irHash) return;
  const wordXml = readVerified(state.renders.word.filePath, state.renders.word.sha256, "Export", { ownerKey: ctx.ownerKey });
  const excel = readVerified(state.renders.excel.filePath, state.renders.excel.sha256, "Export", { ownerKey: ctx.ownerKey });
  const wordText = wordXml.toString("utf8");
  const excelText = excel.toString("utf8");
  state.parity = spotCheckParity({
    irHash: pkg.irHash!,
    controls: pkg.controls,
    oscalXml,
    wordXml: wordText,
    excelControlsXml: excelText,
  });
}

export function renderWord(
  state: PersistedState,
  ctx: Ctx & { outDir: string },
): { state: PersistedState; filePath: string; packageState: PackageState } {
  const pkg = requireGreen(state, ctx);
  const wordXml = renderWordXml(pkg.controls, state.workspaceName ?? "OSCAL binder");
  const owner = blobOwner(ctx.ownerKey);
  const filePath = owner ? exportBlobKey(owner, "package.docx") : path.join(ctx.outDir, "package.docx");
  const retained = retainBytes({
    location: filePath,
    bytes: packageDocx(wordXml),
    contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    label: "Export",
  });
  const next = clone(state);
  const exportId = next.exports.at(-1)?.id ?? "";
  next.renders.word = {
    kind: "word",
    filename: "package.docx",
    at: nowOf(ctx).toISOString(),
    irHash: pkg.irHash!,
    filePath,
    sha256: retained.sha256,
    exportId,
  };
  const lastExport = next.exports.at(-1);
  if (lastExport?.filePath) refreshParity(next, ctx, readVerified(lastExport.filePath, lastExport.sha256, "Export", { ownerKey: ctx.ownerKey }).toString("utf8"));
  return { state: next, filePath, packageState: getPackageState(next, ctx) };
}

export function renderExcel(
  state: PersistedState,
  ctx: Ctx & { outDir: string },
): { state: PersistedState; filePath: string; packageState: PackageState } {
  const pkg = requireGreen(state, ctx);
  const sheets = renderExcelSheets(pkg.controls, state.workspaceName ?? "OSCAL binder");
  const owner = blobOwner(ctx.ownerKey);
  const filePath = owner ? exportBlobKey(owner, "package.xlsx") : path.join(ctx.outDir, "package.xlsx");
  const retained = retainBytes({
    location: filePath,
    bytes: packageXlsx(sheets.controls, sheets.evidence),
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    label: "Export",
  });
  const next = clone(state);
  const exportId = next.exports.at(-1)?.id ?? "";
  next.renders.excel = {
    kind: "excel",
    filename: "package.xlsx",
    at: nowOf(ctx).toISOString(),
    irHash: pkg.irHash!,
    filePath,
    sha256: retained.sha256,
    exportId,
  };
  const lastExport = next.exports.at(-1);
  if (lastExport?.filePath) refreshParity(next, ctx, readVerified(lastExport.filePath, lastExport.sha256, "Export", { ownerKey: ctx.ownerKey }).toString("utf8"));
  return { state: next, filePath, packageState: getPackageState(next, ctx) };
}

export function renderWordExcel(
  state: PersistedState,
  ctx: Ctx & { outDir: string },
): { state: PersistedState; wordPath: string; excelPath: string; packageState: PackageState } {
  const word = renderWord(state, ctx);
  const excel = renderExcel(word.state, ctx);
  return { state: excel.state, wordPath: word.filePath, excelPath: excel.filePath, packageState: excel.packageState };
}

export function updateBaseline(
  state: PersistedState,
  ctx: Ctx,
): { state: PersistedState; baselineId: string; packageState: PackageState } {
  const pkg = requireGreen(state, ctx);
  if (state.baseline && state.baseline.irHash === pkg.irHash) {
    throw new AegisError("BASELINE_CURRENT", "Baseline already matches the current IR.", 409);
  }
  const last = state.exports.at(-1);
  if (!last || last.irHash !== pkg.irHash) {
    throw new AegisError("EXPORT_STALE", "Update baseline uses the GREEN export of the current IR.", 409);
  }
  const next = clone(state);
  const n = next.counters.baseline + 1;
  next.counters.baseline = n;
  const baselineId = padId("bl", n);
  next.baseline = {
    id: baselineId,
    setAt: nowOf(ctx).toISOString(),
    exportId: last.id,
    irHash: pkg.irHash!,
    controls: next.controls.map((control) => ({
      id: control.id,
      title: control.title,
      implementation: control.implementation,
      responsibleRoleId: control.responsibleRoleId,
      evidence: control.evidence.map((item) => ({
        id: item.id,
        title: item.title,
        type: item.type,
        href: item.href,
      })),
    })),
  };
  return { state: next, baselineId, packageState: getPackageState(next, ctx) };
}

export function changesFor(state: PersistedState, ctx: Ctx): ChangesReport {
  return getChanges(state, getPackageState(state, ctx));
}

export function assertReadOnlyCatalog(body: Record<string, unknown>): void {
  if ("catalogPin" in body || "boundaryId" in body || "workspaceName" in body) {
    throw new AegisError("READ_ONLY", "Catalog pin and boundary id are read only.", 400);
  }
}

export function selectCatalog(state: PersistedState, catalogId: string): PersistedState {
  const id = requireCatalogId(catalogId);
  if (state.loaded) {
    throw new AegisError("READ_ONLY", "Catalog pin is read only once a package is loaded.", 400);
  }
  const next = clone(state);
  next.catalogId = id;
  next.catalogPin = pinForCatalog(id);
  return next;
}

/**
 * Drop the loaded package and keep the catalog the operator already chose.
 * The catalog id is the only selection. The pin is derived from it so a reload,
 * upload, sample load, or New package cannot show one baseline and ingest another.
 */
export function resetPackage(state: PersistedState): PersistedState {
  const next = emptyPersisted();
  next.pipelineMappingDecisions = structuredClone(state.pipelineMappingDecisions ?? []);
  if (state.catalogId === "fedramp-rev5" || state.catalogId === "fedramp-20x") {
    next.catalogId = state.catalogId;
    next.catalogPin = pinForCatalog(state.catalogId);
  }
  return next;
}

export function resetWorkspace(): PersistedState {
  return emptyPersisted();
}

export function recordArtifactMappingDecision(
  state: PersistedState,
  record: PipelineEvidence,
  proposal: ArtifactMappingProposal,
  status: "accepted" | "rejected",
  decidedAt: string,
  controls?: string[],
  reviewer?: string,
): PersistedState {
  const next = clone(state);
  const previous = next.pipelineMappingDecisions ?? [];
  const decision = mappingDecision(record, proposal, status, decidedAt, controls, reviewer);
  next.pipelineMappingDecisions = [
    ...previous.filter(item => item.proposalKey !== proposal.key),
    decision,
  ].slice(-100);
  return next;
}

/**
 * Catalog chosen for upload or the gold fixture.
 * `catalogId` is the source of truth. A missing or drifted pin does not mean
 * the operator still has to choose — that disagreement was CATALOG_REQUIRED
 * while the Rev5 radio already looked selected.
 */
export function assertCatalogChosen(
  state: PersistedState,
  requested: string,
  action: "upload" | "gold",
): "fedramp-rev5" | "fedramp-20x" {
  const id = state.catalogId;
  if (id !== "fedramp-rev5" && id !== "fedramp-20x") {
    const message = action === "gold"
      ? "Choose FedRAMP Rev5 or FedRAMP 20x before the demo sample package."
      : "Choose FedRAMP Rev5 or FedRAMP 20x before upload.";
    throw new AegisError("CATALOG_REQUIRED", message, 400);
  }
  const asked = requested.trim();
  if (asked && asked !== id) {
    const selected = id === "fedramp-20x" ? "FedRAMP 20x" : "FedRAMP Rev5";
    throw new AegisError(
      "CATALOG_MISMATCH",
      `Selected baseline is ${selected}. Choose that baseline again before ${action === "gold" ? "the demo sample package" : "upload"}.`,
      400,
    );
  }
  return id;
}

const MAX_EVIDENCE_BYTES = 8 * 1024 * 1024;

function safeSegment(value: string): string {
  const base = path.basename(value).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!base || base === "." || base === ".." || base.includes("..")) return "file";
  return base.slice(0, 80);
}

export function addEvidenceFile(
  state: PersistedState,
  controlId: string,
  file: { filename: string; bytes: Buffer; title: string; type: string },
  ctx: Ctx,
): PersistedState {
  requireLoaded(state);
  if (file.bytes.length === 0) throw new AegisError("INGEST_REJECTED", "The evidence file is empty.", 400);
  if (file.bytes.length > MAX_EVIDENCE_BYTES) {
    throw new AegisError("INGEST_REJECTED", "Evidence file is larger than 8 MB.", 400);
  }
  findControl(state, controlId);
  const controlSegment = safeSegment(controlId);
  const stored = `${randomUUID()}-${safeSegment(file.filename || "evidence")}`;
  const owner = blobOwner(ctx.ownerKey);
  const fullPath = owner
    ? evidenceBlobKey(owner, controlSegment, stored)
    : path.join(dataDir(ctx.root), "uploads", controlSegment, stored);
  const retained = retainBytes({ location: fullPath, bytes: file.bytes, contentType: "application/octet-stream", label: "Evidence file" });
  const href = `workspace-evidence/${controlSegment}/${stored}`;
  try {
    const next = addEvidence(state, controlId, {
      title: file.title.trim() || safeSegment(file.filename || "evidence"),
      type: file.type.trim() || "Document",
      href,
      sha256: retained.sha256,
    }, ctx);
    findControl(next, controlId).evidence.at(-1)!.storedAt = nowOf(ctx).toISOString();
    return next;
  } catch (error) {
    discardRetained(fullPath);
    throw error;
  }
}

function readVerifiedOrMissing(filePath: string, sha256: string | undefined, ownerKey?: string): Buffer | null {
  try {
    return readVerified(filePath, sha256, "Export", { ownerKey });
  } catch (error) {
    if (error instanceof AegisError && error.code === "NOT_FOUND") return null;
    throw error;
  }
}
