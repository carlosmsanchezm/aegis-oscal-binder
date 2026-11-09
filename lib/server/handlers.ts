import {documentModel,assertSchema} from "@/lib/oscal/validate-schema";
import {referenceInventory} from "@/lib/collector/reference-inventory";
import {RECORDED_EVIDENCE} from "@/lib/aegis/recorded-evidence";
import { connectedHistory } from "./remediation-draft";
import { durableStorageConfigured } from "@/lib/durable";
import { flushRetainedWrites, readRetainedSync, retainBytes } from "@/lib/retained-bytes";
import {
  AegisError,
  D6_ID,
  D6_TEXT,
  FUTURE_STUBS,
  addEvidence,
  assertReadOnlyCatalog,
  changesFor,
  exportOscal,
  exportedOscalXml,
  getPackageState,
  getSession,
  addEvidenceFile,
  ingestCsvPackage,
  ingestOscalPackage,
  loadFixture,
  outDir,
  renderExcel,
  renderWord,
  renderWordExcel,
  assertCatalogChosen,
  resetPackage,
  resetWorkspace,
  saveControl,
  selectCatalog,
  recordArtifactMappingDecision,
  updateBaseline,
  updateControl,
  updateEvidence,
  validateOscal,
  type EvidenceInput,
} from "@/lib/aegis";
import { evidenceMappingProfile, mappingProfile, sameMappingProfile, proposeArtifactMappings } from "@/lib/aegis/artifact-mapping";
import { releaseProject } from "@/lib/aegis/control-rollup";
import { CCM_EXAMPLE } from "@/lib/aegis/pipeline-evidence";
import { readMeasurementText } from "@/lib/aegis/measurement";
import { readFileSync } from "node:fs";
import path from "node:path";
import { carriedThroughFrom, buildPackageSsp } from "@/lib/aegis/ssp-export";
import { namedInAdvance, roundTripPackage } from "@/lib/aegis/round-trip";
import { compareUploadedSsp } from "@/lib/aegis/package-compare";
import { collectImportProblems, enforceableImportProblems, reportImportProblems, type ImportProblem } from "@/lib/aegis/import-problems";
import { readStatementPart, readStatementParts, saveStatementPart } from "@/lib/aegis/statement-parts";
import { sspSchemaReport } from "@/lib/aegis/ssp-schema-report";
import { findRepoRoot } from "@/lib/aegis/paths";
import { artifactLocation } from "@/lib/aegis/artifact-location";
import { digestObjectKey } from "@/lib/digest-audit";
import type { CatalogId } from "@/lib/aegis/types";
import { jsonOk, readJson } from "./http";
import { readReleaseHistory } from "./pipeline-inbound";

function session() {
  return getSession();
}

const SESSION_LOST = "This browser's package was not found on the server. Reload the page, or upload the package again.";

function requireSessionPackage(): void {
  const current = session();
  if (current.state.loaded || !current.orphaned) return;
  throw new AegisError("SESSION_LOST", SESSION_LOST, 409);
}

function stringField(body: Record<string, unknown>, key: string): string | undefined {
  if (!(key in body)) return undefined;
  const value = body[key];
  if (typeof value !== "string") throw new AegisError("BAD_REQUEST", `${key} must be a string`, 400);
  return value;
}

function evidenceBody(value: unknown): EvidenceInput | null {
  if (value == null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new AegisError("BAD_REQUEST", "evidence must be an object", 400);
  }
  const record = value as Record<string, unknown>;
  for (const key of ["title", "type", "href"]) {
    if (record[key] != null && typeof record[key] !== "string") {
      throw new AegisError("BAD_REQUEST", `evidence.${key} must be a string`, 400);
    }
  }
  return {
    title: typeof record.title === "string" ? record.title : "",
    type: typeof record.type === "string" ? record.type : "",
    href: typeof record.href === "string" ? record.href : "",
  };
}

export function getDisclaimer(): Response {
  return jsonOk({ disclaimer: { id: D6_ID, text: D6_TEXT } });
}

export function getPackage(): Response {
  const current = session();
  return jsonOk({ packageState: getPackageState(current.state, current.ctx) });
}

export function getGate(): Response {
  const current = session();
  return jsonOk({ gate: getPackageState(current.state, current.ctx).gate });
}

export function getChanges(): Response {
  const current = session();
  return jsonOk({ changes: changesFor(current.state, current.ctx) });
}

export function getFuture(): Response {
  return jsonOk({
    liveConnections: 0,
    note: "Future / stub — not built, not wired, not in the demo loop.",
    stubs: FUTURE_STUBS,
  });
}

export function getAttempts(): Response {
  const current = session();
  return jsonOk({ blockedAttempts: current.state.blockedAttempts });
}

function currentMappingProfile(scope: unknown = "package") {
  const state = session().state;
  const catalogId = state.catalogId ?? "fedramp-rev5";
  if (scope !== "package" && scope !== "catalog") throw new AegisError("BAD_REQUEST", "Choose package or catalog mapping scope.", 400);
  if (scope === "package" && state.loaded) return mappingProfile(state.controls.map(control => control.id), catalogId);
  return evidenceMappingProfile(catalogId, state.controls.map(control => control.id));
}

export function getPipelineMappings(request?: Request): Response {
  const scope = request ? request.headers.get("x-aegis-mapping-scope") ?? new URL(request.url).searchParams.get("scope") ?? "package" : "package";
  const profile = currentMappingProfile(scope);
  return jsonOk({ decisions: (session().state.pipelineMappingDecisions ?? []).filter(decision => scope === "catalog" ? decision.profile?.catalogId === profile.catalogId : sameMappingProfile(decision.profile, profile)) });
}

export async function postPipelineMapping(body: Record<string, unknown>, request?: Request): Promise<Response> {
  const proposalKey = stringField(body, "proposalKey");
  const status = stringField(body, "status");
  if (!proposalKey || (status !== "accepted" && status !== "rejected")) {
    throw new AegisError("BAD_REQUEST", "Choose Accept or Reject for a current mapping proposal.", 400);
  }
  const profile = currentMappingProfile(body.scope ?? "package");
  if (!sameMappingProfile(body.profile, profile)) throw new AegisError("PROPOSAL_STALE", "The selected profile changed. Review the current proposal before deciding.", 409);
  let received: Awaited<ReturnType<typeof readReleaseHistory>> = [];
  try {
    received = await readReleaseHistory();
  } catch (error) {
    if (durableStorageConfigured() || !(error instanceof Error) || error.message !== "Durable storage is not configured.") throw error;
  }
  const receivedEvidence = received.map(item => item.evidence);
  const publicUrl = request ? new URL(request.url) : null;
  if (publicUrl && request) {
    publicUrl.host = request.headers.get("host") ?? publicUrl.host;
    publicUrl.protocol = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() === "https" ? "https:" : publicUrl.protocol;
  }
  const connected = request && publicUrl ? await connectedHistory(request.headers.get("cookie"), publicUrl.origin) : [];
  const releases = [...new Map([...RECORDED_EVIDENCE, ...receivedEvidence, ...connected].map(record => [
    JSON.stringify([record.pipelineUrl, record.commitSha, record.releaseSha256]),
    record,
  ])).values()].map(referenceInventory);
  const allowed = profile.controlIds;
  let match: { record: (typeof releases)[number]; proposal: ReturnType<typeof proposeArtifactMappings>[number] } | null = null;
  for (const record of releases) {
    const prior = releases.filter(candidate =>
      candidate !== record
      && releaseProject(candidate.pipelineUrl) === releaseProject(record.pipelineUrl)
      && Date.parse(candidate.createdAt) < Date.parse(record.createdAt),
    );
    const proposal = proposeArtifactMappings(record, allowed, prior, profile.catalogId).find(item => item.key === proposalKey);
    if (proposal) {
      match = { record, proposal };
      break;
    }
  }
  if (!match) throw new AegisError("PROPOSAL_NOT_FOUND", "This mapping proposal is no longer current.", 409);
  const current = session();
  const controls = body.controls === undefined ? match.proposal.candidates.map(c => c.controlId) : body.controls;
  const reviewer = typeof body.reviewer === "string" ? body.reviewer.trim() : "";
  if (!Array.isArray(controls) || !controls.length || new Set(controls).size !== controls.length || controls.some(id => typeof id !== "string" || !match!.proposal.candidates.some(c => c.controlId === id)) || reviewer.length > 200) throw new AegisError("BAD_REQUEST", "Review the proposed controls before accepting.", 400);
  const next = recordArtifactMappingDecision(current.state, match.record, match.proposal, status, new Date().toISOString(), controls, reviewer);
  current.commit(next);
  return jsonOk({ decision: next.pipelineMappingDecisions?.find(item => item.proposalKey === proposalKey) });
}

export function postSelectCatalog(body: Record<string, unknown>): Response {
  const catalog = stringField(body, "catalog");
  if (!catalog) throw new AegisError("UNKNOWN_CATALOG", "Choose FedRAMP Rev5 or FedRAMP 20x.", 400);
  const current = session();
  const next = selectCatalog(current.state, catalog);
  current.commit(next);
  return jsonOk({ packageState: getPackageState(next, current.ctx) });
}

export function getCatalogs(): Response {
  const current = session();
  const packageState = getPackageState(current.state, current.ctx);
  return jsonOk({
    catalogs: packageState.catalogChoices,
    activeCatalogId: packageState.catalog.id,
    bound: packageState.catalog.bound,
  });
}

async function readUpload(req: Request, fallbackCatalog: string): Promise<{ text: string; filename: string; catalogId: string }> {
  const contentType = req.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const body = await readJson(req);
    const document = stringField(body, "document");
    if (document == null) throw new AegisError("INGEST_REJECTED", "JSON ingest requires a document string.", 400);
    return {
      text: document,
      filename: stringField(body, "filename") ?? "upload.json",
      catalogId: stringField(body, "catalog") ?? fallbackCatalog,
    };
  }
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    throw new AegisError("INGEST_REJECTED", "Upload body could not be read. Send a file or a JSON document.", 400);
  }
  const file = form.get("file");
  if (typeof file === "string" || file == null || typeof (file as Blob).text !== "function") {
    throw new AegisError("INGEST_REJECTED", "Choose a file to upload.", 400);
  }
  const upload = file as File;
  const catalogField = form.get("catalog");
  return {
    text: await upload.text(),
    filename: upload.name || "upload",
    catalogId: typeof catalogField === "string" && catalogField.trim() ? catalogField.trim() : fallbackCatalog,
  };
}

function requireChosenCatalog(state: Parameters<typeof assertCatalogChosen>[0], requested: string, action: "upload" | "gold"): "fedramp-rev5" | "fedramp-20x" {
  return assertCatalogChosen(state, requested, action);
}

function importSummaryFor(state: ReturnType<typeof session>["state"], ctx: ReturnType<typeof session>["ctx"]) {
  const pkg = getPackageState(state, ctx);
  const census = state.importCensus ?? null;
  return {
    file: census?.filename ?? state.sourceFilename,
    bytes: census?.bytes ?? null,
    parserReason: census ? null : "Parser counts are recorded when an OSCAL SSP is ingested.",
    profilePin: pkg.catalogPin,
    profile: pkg.gate.profile ?? null,
    controlsFound: census?.controlsFound ?? null,
    statements: census?.statements ?? null,
    components: census?.components ?? null,
    roles: census?.roles ?? null,
    evidenceResources: census?.evidenceResources ?? null,
    resolvedControls: state.loaded ? pkg.inScopeCount : null,
    gate: pkg.gate,
    namedInAdvance: namedInAdvance(),
    carriedThrough: carriedThroughFrom(state.sourceSsp),
  };
}

async function storeJsonArtifact(
  current: ReturnType<typeof session>,
  kind: "reports" | "measurements",
  name: string,
  body: unknown,
): Promise<{ filePath: string; sha256: string; objectKey: string }> {
  if(documentModel(body))assertSchema(body);
  const location = artifactLocation(current.id, kind, name, current.ctx.root);
  const bytes = Buffer.from(JSON.stringify(body));
  const retained = retainBytes({ location, bytes, contentType: "application/json", label: "Export" });
  await flushRetainedWrites();
  return { filePath: location, sha256: retained.sha256, objectKey: digestObjectKey(location) };
}

function readStoredJson(current: ReturnType<typeof session>, filePath: string, sha256: string): unknown {
  const bytes = readRetainedSync(filePath, sha256, "Export", { ownerKey: current.id });
  if (!bytes) throw new AegisError("NOT_FOUND", "The stored report is not available.", 404, { reason: "NOT_STORED" });
  return JSON.parse(bytes.toString("utf8"));
}

function failureKind(code: string): ImportProblem["kind"] {
  if (code === "CATALOG_MISMATCH") return "unsupported profile";
  if (code === "PROFILE_CONTROLS") return "unknown control id";
  return "missing required property";
}

async function rememberImportReport(
  current: ReturnType<typeof session>,
  report: ReturnType<typeof reportImportProblems>,
): Promise<void> {
  try {
    const stored = await storeJsonArtifact(current, "reports", "import-report.json", report);
    const next = structuredClone(current.state);
    next.importReport = { filePath: stored.filePath, sha256: stored.sha256, storedAt: new Date().toISOString() };
    current.commit(next);
  } catch {
    // The package is still not replaced when the report cannot be stored.
  }
}

export async function postOscalIngest(req: Request): Promise<Response> {
  const current = session();
  const upload = await readUpload(req, current.state.catalogId ?? "");
  upload.catalogId = requireChosenCatalog(current.state, upload.catalogId, "upload");
  const catalogId = upload.catalogId as CatalogId;
  const found = collectImportProblems(upload.text, catalogId, current.ctx.root);
  if (enforceableImportProblems(found).length > 0) {
    const report = reportImportProblems(found);
    await rememberImportReport(current, report);
    throw new AegisError("IMPORT_REJECTED", `Import stopped. ${report.total} problems. No package was stored.`, 400, report);
  }
  try {
    const next = ingestOscalPackage(upload, current.ctx);
    next.pipelineMappingDecisions = structuredClone(current.state.pipelineMappingDecisions ?? []);
    current.commit(next);
    return jsonOk({ packageState: getPackageState(next, current.ctx), importSummary: importSummaryFor(next, current.ctx) });
  } catch (error) {
    if (!(error instanceof AegisError)) throw error;
    const problems = found.length > 0 ? found : [{
      kind: failureKind(error.code),
      path: "/",
      message: error.message,
      fix: null,
    }];
    const report = reportImportProblems(problems);
    await rememberImportReport(current, report);
    throw new AegisError(error.code, error.message, error.status, report);
  }
}

export function getImportSummary(): Response {
  const current = session();
  return jsonOk({ importSummary: importSummaryFor(current.state, current.ctx) });
}

export function getImportReport(): Response {
  const current = session();
  const stored = current.state.importReport;
  if (!stored) throw new AegisError("NOT_FOUND", "No import report is stored.", 404, { reason: "NO_IMPORT_REPORT" });
  const body = readStoredJson(current, stored.filePath, stored.sha256);
  return new Response(JSON.stringify(body), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": "attachment; filename=\"import-report.json\"",
    },
  });
}

export async function postCsvIngest(req: Request): Promise<Response> {
  const current = session();
  const upload = await readUpload(req, current.state.catalogId ?? "");
  upload.catalogId = requireChosenCatalog(current.state, upload.catalogId, "upload");
  const next = ingestCsvPackage(upload, current.ctx);
  next.pipelineMappingDecisions = structuredClone(current.state.pipelineMappingDecisions ?? []);
  current.commit(next);
  return jsonOk({ packageState: getPackageState(next, current.ctx) });
}

export function postResetPackage(): Response {
  const current = session();
  const next = resetPackage(current.state);
  current.commit(next);
  return jsonOk({ packageState: getPackageState(next, current.ctx) });
}

export function postResetWorkspace(): Response {
  const current = session();
  const next = resetWorkspace();
  current.commit(next);
  return jsonOk({ packageState: getPackageState(next, current.ctx) });
}

export async function postEvidenceFile(controlId: string, req: Request): Promise<Response> {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    throw new AegisError("INGEST_REJECTED", "Evidence upload could not be read.", 400);
  }
  const file = form.get("file");
  if (typeof file === "string" || file == null || typeof (file as Blob).arrayBuffer !== "function") {
    throw new AegisError("INGEST_REJECTED", "Choose a file to attach as evidence.", 400);
  }
  const upload = file as File;
  const bytes = Buffer.from(await upload.arrayBuffer());
  const titleField = form.get("title");
  const typeField = form.get("type");
  const current = session();
  const next = addEvidenceFile(current.state, controlId, {
    filename: upload.name || "evidence",
    bytes,
    title: typeof titleField === "string" ? titleField : "",
    type: typeof typeField === "string" ? typeField : "",
  }, current.ctx);
  await flushRetainedWrites();
  current.commit(next);
  return jsonOk({ packageState: getPackageState(next, current.ctx) });
}

export function postLoad(body: Record<string, unknown>): Response {
  assertReadOnlyCatalog(body);
  const fixture = stringField(body, "fixture") ?? "gold";
  const current = session();
  requireChosenCatalog(current.state, current.state.catalogId ?? "", "gold");
  const next = loadFixture(current.state, fixture, current.ctx);
  current.commit(next);
  return jsonOk({ packageState: getPackageState(next, current.ctx) });
}

export function patchControl(controlId: string, body: Record<string, unknown>): Response {
  assertReadOnlyCatalog(body);
  const current = session();
  const next = updateControl(
    current.state,
    controlId,
    {
      implementation: stringField(body, "implementation"),
      responsibleRole: stringField(body, "responsibleRole"),
      responsibleRoles: stringField(body, "responsibleRoles"),
    },
    current.ctx,
  );
  current.commit(next);
  return jsonOk({ packageState: getPackageState(next, current.ctx) });
}

export function postSave(controlId: string, body: Record<string, unknown>): Response {
  assertReadOnlyCatalog(body);
  requireSessionPackage();
  const current = session();
  const next = saveControl(
    current.state,
    controlId,
    {
      implementation: stringField(body, "implementation"),
      responsibleRole: stringField(body, "responsibleRole"),
      responsibleRoles: stringField(body, "responsibleRoles"),
      evidence: evidenceBody(body.evidence),
    },
    current.ctx,
  );
  current.commit(next);
  return jsonOk({ packageState: getPackageState(next, current.ctx) });
}

export function postEvidence(controlId: string, body: Record<string, unknown>): Response {
  assertReadOnlyCatalog(body);
  const current = session();
  const next = addEvidence(
    current.state,
    controlId,
    {
      title: stringField(body, "title") ?? "",
      type: stringField(body, "type") ?? "",
      href: stringField(body, "href") ?? "",
    },
    current.ctx,
  );
  current.commit(next);
  return jsonOk({ packageState: getPackageState(next, current.ctx) });
}

export function patchEvidence(controlId: string, evidenceId: string, body: Record<string, unknown>): Response {
  assertReadOnlyCatalog(body);
  const current = session();
  const existing = current.state.controls.find((control) => control.id === controlId)?.evidence.find((item) => item.id === evidenceId);
  const next = updateEvidence(
    current.state,
    controlId,
    evidenceId,
    {
      title: stringField(body, "title") ?? existing?.title ?? "",
      type: stringField(body, "type") ?? existing?.type ?? "",
      href: stringField(body, "href") ?? existing?.href ?? "",
    },
    current.ctx,
  );
  current.commit(next);
  return jsonOk({ packageState: getPackageState(next, current.ctx) });
}

export async function postExport(): Promise<Response> {
  requireSessionPackage();
  const current = session();
  const result = exportOscal(current.state, { ...current.ctx, outDir: outDir(current.ctx.root, current.id) });
  await flushRetainedWrites();
  current.commit(result.state);
  return jsonOk({
    exportId: result.exportId,
    bundlePath: result.bundlePath,
    filename: result.filename,
    xml: result.xml,
    packageState: result.packageState,
  });
}

export function postValidate(body: Record<string, unknown>): Response {
  const scenario = stringField(body, "scenario") ?? "current";
  if (scenario !== "current" && scenario !== "red") {
    throw new AegisError("BAD_REQUEST", 'scenario must be "current" or "red"', 400);
  }
  const current = session();
  const result = validateOscal(current.state, current.ctx, scenario);
  current.commit(result.state);
  return jsonOk({
    validation: result.validation,
    packageState: result.packageState,
  });
}

export async function postRender(target: "word" | "excel" | "both"): Promise<Response> {
  const current = session();
  const ctx = { ...current.ctx, outDir: outDir(current.ctx.root, current.id) };
  if (target === "both") {
    const result = renderWordExcel(current.state, ctx);
    await flushRetainedWrites();
    current.commit(result.state);
    return jsonOk({ packageState: result.packageState, parity: result.packageState.pipeline.parity });
  }
  const result = target === "word" ? renderWord(current.state, ctx) : renderExcel(current.state, ctx);
  await flushRetainedWrites();
  current.commit(result.state);
  return jsonOk({ packageState: result.packageState, parity: result.packageState.pipeline.parity });
}

export function postBaseline(): Response {
  const current = session();
  const result = updateBaseline(current.state, current.ctx);
  current.commit(result.state);
  return jsonOk({ baselineId: result.baselineId, packageState: result.packageState });
}

function fileResponse(filePath: string | undefined, sha256: string | undefined, contentType: string, filename: string): Response {
  if (!filePath) throw new AegisError("NOT_FOUND", `${filename} has not been written.`, 404);
  const body = readRetainedSync(filePath, sha256, "Export", { ownerKey: session().id });
  if (!body) throw new AegisError("NOT_FOUND", `${filename} has not been written.`, 404);
  const headers: Record<string, string> = {
    "content-type": contentType,
    "content-disposition": `attachment; filename="${filename}"`,
  };
  if (!sha256) headers["x-aegis-digest"] = "DIGEST_UNVERIFIED";
  return new Response(new Uint8Array(body), { headers });
}

export function getOscalArtifact(): Response {
  requireSessionPackage();
  const current = session();
  const last = current.state.exports.at(-1);
  if (!last) {
    throw new AegisError("NOT_FOUND", "package-oscal.xml has not been written.", 404);
  }
  const xml = exportedOscalXml(current.state, current.ctx);
  const headers: Record<string, string> = {
    "content-type": "application/xml; charset=utf-8",
    "content-disposition": `attachment; filename="${last.filename}"`,
  };
  if (!last.sha256) headers["x-aegis-digest"] = "DIGEST_UNVERIFIED";
  return new Response(xml, { headers });
}

export function getWordArtifact(): Response {
  const render = session().state.renders.word;
  return fileResponse(
    render?.filePath,
    render?.sha256,
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "package.docx",
  );
}

export function getExcelArtifact(): Response {
  const render = session().state.renders.excel;
  return fileResponse(
    render?.filePath,
    render?.sha256,
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "package.xlsx",
  );
}

export function getControlParts(controlId: string): Response {
  const current = session();
  return jsonOk({ parts: readStatementParts(current.state, controlId, current.ctx) });
}

export function getControlPart(controlId: string, statementId: string): Response {
  const current = session();
  return jsonOk({ part: readStatementPart(current.state, controlId, statementId, current.ctx) });
}

export function putControlPart(controlId: string, statementId: string, body: Record<string, unknown>): Response {
  assertReadOnlyCatalog(body);
  requireSessionPackage();
  const current = session();
  const next = saveStatementPart(current.state, controlId, statementId, {
    implementation: stringField(body, "implementation"),
    evidence: evidenceBody(body.evidence),
  }, current.ctx);
  current.commit(next);
  return jsonOk({
    part: readStatementPart(next, controlId, statementId, current.ctx),
    packageState: getPackageState(next, current.ctx),
  });
}

export async function postSspSchema(body: Record<string, unknown>): Promise<Response> {
  const current = session();
  const checkedAt = new Date().toISOString();
  let document: unknown;
  let exportId: string | null = null;
  let sspObjectKey: string | null = null;
  if ("document" in body && body.document != null) {
    if (typeof body.document === "string") {
      try {
        document = JSON.parse(body.document);
      } catch {
        throw new AegisError("BAD_REQUEST", "document must be an OSCAL JSON SSP.", 400);
      }
    } else if (typeof body.document === "object") {
      document = body.document;
    } else {
      throw new AegisError("BAD_REQUEST", "document must be an OSCAL JSON SSP.", 400);
    }
  } else {
    if (!current.state.loaded) throw new AegisError("NO_FIXTURE", "Load an OSCAL package or the demo sample package first.", 400);
    document = buildPackageSsp(current.state, new Date());
    exportId = current.state.exports.at(-1)?.id ?? null;
    const stored = await storeJsonArtifact(current, "reports", "package-ssp.json", document);
    sspObjectKey = stored.objectKey;
    exportId = exportId ?? "package-ssp";
  }
  const report = sspSchemaReport(document, checkedAt, exportId && sspObjectKey ? { exportId, objectKey: sspObjectKey } : null);
  const storedReport = await storeJsonArtifact(current, "reports", "ssp-schema-report.json", report);
  const next = structuredClone(current.state);
  next.schemaReport = { filePath: storedReport.filePath, sha256: storedReport.sha256, storedAt: checkedAt };
  current.commit(next);
  return jsonOk({ schemaReport: report });
}

export function getSspSchemaReport(): Response {
  const current = session();
  const stored = current.state.schemaReport;
  if (!stored) throw new AegisError("NOT_FOUND", "No SSP schema report is stored.", 404, { reason: "NO_SCHEMA_REPORT" });
  const body = readStoredJson(current, stored.filePath, stored.sha256);
  return new Response(JSON.stringify(body), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": "attachment; filename=\"ssp-schema-report.json\"",
    },
  });
}

export function getRoundTrip(): Response {
  const current = session();
  return jsonOk({ roundTrip: roundTripPackage(current.state, current.ctx) });
}

export function postCompare(body: Record<string, unknown>): Response {
  const document = stringField(body, "document");
  if (document == null) throw new AegisError("BAD_REQUEST", "document must be the uploaded SSP text.", 400);
  const filename = stringField(body, "filename") ?? "upload.json";
  const current = session();
  return jsonOk({ compare: compareUploadedSsp(current.state, document, filename, current.ctx) });
}

export function getMeasurement323(): Response {
  const file = path.join(findRepoRoot(), "fixtures", "measurements", "323.json");
  let text: string | null;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    text = null;
  }
  const record = readMeasurementText(text);
  if (record.measurement == null) return jsonOk({ measurement: null, reason: record.reason });
  return jsonOk({ measurement: record.measurement, digest: record.digest });
}
