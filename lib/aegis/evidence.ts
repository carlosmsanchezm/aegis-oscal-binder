import { randomUUID } from "node:crypto";
import { DIGEST_MISMATCH_CODE, DIGEST_UNVERIFIED_CODE, DIGEST_UNVERIFIED_MESSAGE, locateWorkspaceEvidence, objectPresent, readRetainedSync } from "../retained-bytes";
import { getStorage } from "../storage";
import { EVIDENCE_TYPES } from "./constants";
import { AegisError, type EvidenceProblem } from "./errors";
import { resolveEvidenceHref } from "./paths";
import type { ControlRecord, Ctx, EvidenceInput, EvidenceRecord, EvidenceType, Role } from "./types";

const INVALID_URL = "Invalid URL · use https:// or an evidence/ path";

export function canonicalEvidenceType(value: string): EvidenceType | null {
  const found = EVIDENCE_TYPES.find((item) => item.toLowerCase() === value.trim().toLowerCase());
  return found ?? null;
}

export function roleTitle(roles: Role[], roleId: string): string {
  if (!roleId) return "";
  return roles.find((role) => role.id === roleId)?.title ?? "";
}

export function resolveRole(roles: Role[], value: string): Role | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  return (
    roles.find((role) => role.id === trimmed || role.title.toLowerCase() === trimmed.toLowerCase()) ?? null
  );
}

export function classifyHref(href: string): { ok: true; kind: "file" | "url" } | { ok: false; message: string } {
  const trimmed = href.trim();
  if (!trimmed) return { ok: false, message: INVALID_URL };
  if (trimmed.startsWith("evidence/") || trimmed.startsWith("workspace-evidence/")) {
    if (trimmed.includes("..") || trimmed.includes("\\") || trimmed.includes("\0")) {
      return { ok: false, message: INVALID_URL };
    }
    return { ok: true, kind: "file" };
  }
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" || !url.hostname) return { ok: false, message: INVALID_URL };
    return { ok: true, kind: "url" };
  } catch {
    return { ok: false, message: INVALID_URL };
  }
}

export function inspectEvidence(
  control: ControlRecord,
  input: EvidenceInput,
  ctx: Ctx,
  ignoreEvidenceId?: string,
): EvidenceProblem[] {
  const problems: EvidenceProblem[] = [];
  const title = input.title.trim();
  if (!title) {
    problems.push({ code: "TITLE_REQUIRED", message: "Title is required" });
  } else {
    const duplicate = control.evidence.find(
      (item) => item.id !== ignoreEvidenceId && item.title.trim().toLowerCase() === title.toLowerCase(),
    );
    if (duplicate) {
      problems.push({
        code: "DUPLICATE_TITLE",
        message: `Duplicate title · already used by ${duplicate.id}`,
      });
    }
  }

  if (!canonicalEvidenceType(input.type)) {
    problems.push({
      code: "TYPE_UNKNOWN",
      message: "Unknown evidence type · use Document, Link, Screenshot, or Log",
    });
  }

  const href = classifyHref(input.href);
  if (!href.ok) {
    problems.push({ code: "INVALID_URL", message: href.message });
  } else if (href.kind === "file") {
    const trimmed = input.href.trim();
    if (trimmed.startsWith("workspace-evidence/")) {
      const resolved = locateWorkspaceEvidence(ctx.root, trimmed, ctx.ownerKey);
      if (!resolved || !objectPresent(resolved)) {
        problems.push({ code: "MISSING_FILE", message: "Missing file · nothing at this path" });
      }
    } else {
      const resolved = resolveEvidenceHref(ctx.root, trimmed);
      if (!resolved || !getStorage().exists(resolved)) {
        problems.push({ code: "MISSING_FILE", message: "Missing file · nothing at this path" });
      }
    }
  }

  return problems;
}

export function evidenceFileStatus(record: EvidenceRecord, ctx: Ctx): { valid: boolean; errors: string[]; fileStatus: string } {
  const problems = inspectEvidence(
    { id: "", title: "", family: "", implementation: "", responsibleRoleId: "", evidence: [] },
    { title: record.title, type: record.type, href: record.href },
    ctx,
  );
  const errors = problems.filter((problem) => problem.code !== "TITLE_REQUIRED" && problem.code !== "DUPLICATE_TITLE").map((problem) => problem.message);
  const mismatch = digestFailure(record, ctx);
  if (mismatch && mismatch !== DIGEST_UNVERIFIED_MESSAGE) errors.push(mismatch);
  const valid = errors.length === 0 && record.title.trim().length > 0;
  if (valid && mismatch === DIGEST_UNVERIFIED_MESSAGE) {
    return { valid: true, errors: [DIGEST_UNVERIFIED_MESSAGE], fileStatus: DIGEST_UNVERIFIED_CODE };
  }
  if (!valid) {
    return { valid: false, errors, fileStatus: mismatch ? DIGEST_MISMATCH_CODE : errors[0] ?? "Invalid" };
  }
  const href = classifyHref(record.href);
  if (href.ok && href.kind === "url") return { valid: true, errors: [], fileStatus: "HTTPS link" };
  return { valid: true, errors: [], fileStatus: "File found" };
}

function digestFailure(record: EvidenceRecord, ctx: Ctx): string | null {
  if (!record.href.startsWith("workspace-evidence/")) return null;
  const location = locateWorkspaceEvidence(ctx.root, record.href, ctx.ownerKey);
  if (!location || !objectPresent(location)) return null;
  try {
    const bytes = readRetainedSync(location, record.sha256, "Evidence file", { ownerKey: ctx.ownerKey, recordAudit: false });
    if (!bytes) return null;
    return record.sha256 ? null : DIGEST_UNVERIFIED_MESSAGE;
  } catch (error) {
    if (error instanceof AegisError && error.code === DIGEST_MISMATCH_CODE) return error.message;
    throw error;
  }
}

export function requireEvidence(control: ControlRecord, input: EvidenceInput, ctx: Ctx, ignoreEvidenceId?: string): EvidenceInput & { type: EvidenceType } {
  const problems = inspectEvidence(control, input, ctx, ignoreEvidenceId);
  if (problems.length > 0) {
    throw new AegisError("EVIDENCE_REJECTED", "Evidence was not added", 400, problems);
  }
  const type = canonicalEvidenceType(input.type);
  if (!type) throw new AegisError("EVIDENCE_REJECTED", "Evidence was not added", 400, problems);
  return { title: input.title.trim(), type, href: input.href.trim() };
}

export function nextEvidenceId(control: ControlRecord): string {
  const prefix = `EV-${control.id.replaceAll("-", "")}-`;
  const used = new Set(control.evidence.map((item) => item.id));
  let n = 1;
  while (used.has(`${prefix}${String(n).padStart(2, "0")}`)) n += 1;
  return `${prefix}${String(n).padStart(2, "0")}`;
}

export function newEvidenceUuid(): string {
  return randomUUID();
}
