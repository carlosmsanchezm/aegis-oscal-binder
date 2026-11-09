import path from "node:path";
import { AegisError, getSession } from "@/lib/aegis";
import { DIGEST_CHECK_NOTE, groupDigestRefusals, listDigestAudits, listDigestAuditsForObject } from "@/lib/digest-audit";
import { compareStoredFile, lastDigestCheck, regenerateStoredExport, storedFileInventory, verifyStoredDigests } from "@/lib/digest-recovery";
import { DIGEST_UNVERIFIED_CODE, locateWorkspaceEvidence, readRetainedSync } from "@/lib/retained-bytes";
import { jsonOk } from "./http";

function session() {
  return getSession();
}

export async function getDigestRefusals(): Promise<Response> {
  const current = session();
  const listed = await listDigestAudits(current.id);
  return jsonOk({
    refusals: groupDigestRefusals(listed.entries, listed.truncated),
    truncated: listed.truncated,
  });
}

export async function getDigestRefusal(objectKey: string): Promise<Response> {
  const current = session();
  const listed = await listDigestAuditsForObject(current.id, objectKey);
  if (listed.entries.length === 0) {
    throw new AegisError("NOT_FOUND", "No refused read is recorded for this object.", 404);
  }
  const [group] = groupDigestRefusals(listed.entries, listed.truncated);
  return jsonOk({
    objectKey: group?.objectKey ?? objectKey,
    objectName: group?.objectName ?? "",
    kind: group?.kind ?? null,
    recordedDigest: group?.recordedDigest ?? "",
    recomputedDigest: group?.recomputedDigest ?? "",
    truncated: listed.truncated,
    entries: listed.entries,
  });
}

export async function getDigestCheck(): Promise<Response> {
  const current = session();
  const check = await lastDigestCheck(current.ctx);
  if (!check) {
    return jsonOk({
      files: null,
      matched: null,
      mismatched: null,
      skipped: null,
      checkedAt: null,
      note: DIGEST_CHECK_NOTE,
    });
  }
  return jsonOk({
    files: check.files ?? null,
    matched: check.matched,
    mismatched: check.mismatched,
    skipped: check.skipped,
    checkedAt: check.checkedAt,
    note: check.note,
  });
}

export async function postDigestCheck(body: Record<string, unknown> = {}): Promise<Response> {
  const current = session();
  if ("objectKey" in body) {
    if (typeof body.objectKey !== "string") throw new AegisError("BAD_REQUEST", "Object key must be 64 hex characters.", 400);
    return jsonOk({ result: await compareStoredFile(current.state, current.ctx, body.objectKey) });
  }
  const check = await verifyStoredDigests(current.state, current.ctx);
  return jsonOk({
    files: check.files ?? null,
    matched: check.matched,
    mismatched: check.mismatched,
    skipped: check.skipped,
    checkedAt: check.checkedAt,
    note: check.note,
  });
}

export async function postRegenerateExport(body: Record<string, unknown>): Promise<Response> {
  const exportId = typeof body.exportId === "string" ? body.exportId.trim() : "";
  const render = typeof body.render === "string" ? body.render.trim() : "";
  if (exportId && render) throw new AegisError("BAD_REQUEST", "Choose one export id or one render target.", 400);
  if (!exportId && !render) throw new AegisError("BAD_REQUEST", "Send an export id or a render target.", 400);
  if (render && render !== "word" && render !== "excel") {
    throw new AegisError("BAD_REQUEST", "Render target must be word or excel.", 400);
  }
  if ("exportId" in body && typeof body.exportId !== "string") {
    throw new AegisError("BAD_REQUEST", "Send an export id or a render target.", 400);
  }
  if ("render" in body && typeof body.render !== "string") {
    throw new AegisError("BAD_REQUEST", "Render target must be word or excel.", 400);
  }
  if ("newExport" in body && (typeof body.newExport !== "boolean" || Boolean(render))) {
    throw new AegisError("BAD_REQUEST", "New export must be a boolean and requires an export id.", 400);
  }
  const current = session();
  const result = await regenerateStoredExport(
    current.state,
    current.ctx,
    exportId ? { exportId, ...(body.newExport === true ? { newExport: true } : {}) } : { render: render as "word" | "excel" },
  );
  current.commit(result.state);
  return jsonOk({ regenerated: result.regenerated });
}

export function getEvidenceBytes(controlId: string, evidenceId: string): Response {
  const current = session();
  const control = current.state.controls.find((item) => item.id === controlId);
  if (!control) throw new AegisError("CONTROL_NOT_FOUND", `Unknown control ${controlId}`, 404);
  const item = control.evidence.find((entry) => entry.id === evidenceId);
  if (!item) throw new AegisError("NOT_FOUND", "No evidence item matches that id.", 404);
  if (!item.href.startsWith("workspace-evidence/")) {
    throw new AegisError("NOT_FOUND", "This evidence item has no stored file.", 404);
  }
  const location = locateWorkspaceEvidence(current.ctx.root, item.href, current.id);
  if (!location) throw new AegisError("NOT_FOUND", "Evidence file has not been written.", 404);
  const body = readRetainedSync(location, item.sha256, "Evidence file", { ownerKey: current.id });
  if (!body) throw new AegisError("NOT_FOUND", "Evidence file has not been written.", 404);
  const filename = path.basename(location).replace(/["\r\n]/g, "");
  const headers: Record<string, string> = {
    "content-type": "application/octet-stream",
    "content-disposition": `attachment; filename="${filename}"`,
  };
  if (!item.sha256) headers["x-aegis-digest"] = DIGEST_UNVERIFIED_CODE;
  return new Response(new Uint8Array(body), { headers });
}

export function getStoredFiles(): Response {
  const current = session();
  return jsonOk({ files: storedFileInventory(current.state, current.ctx), baseline: current.state.baseline ? { id: current.state.baseline.id, exportId: current.state.baseline.exportId } : null });
}
