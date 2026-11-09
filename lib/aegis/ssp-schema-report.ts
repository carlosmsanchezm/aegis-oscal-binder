import type { ErrorObject } from "ajv";
import { allSspSchemaErrors, type SspSchemaError } from "./ssp-export";
import { findRepoRoot } from "./paths";

export const SSP_SCHEMA_ID = "oscal-1.1.2-ssp-json";
export const SSP_SCHEMA_CAP = 32;
export const SSP_SCHEMA_SCOPE = "json-ssp";
export const SSP_SCHEMA_SCOPE_NOTE = "The XML download is not covered by this official OSCAL 1.1.2 SSP JSON schema check.";

export type SspSchemaIssue = {
  path: string;
  message: string;
  keyword: string;
  controlId: string | null;
  group: string;
  fix: string | null;
};

export type SspSchemaGroup = {
  key: string;
  label: string;
  controlId: string | null;
  count: number;
  countShown: number;
};

export type SspSchemaReport = {
  schema: typeof SSP_SCHEMA_ID;
  scope: typeof SSP_SCHEMA_SCOPE;
  scopeNote: typeof SSP_SCHEMA_SCOPE_NOTE;
  valid: boolean;
  totalErrors: number;
  cap: typeof SSP_SCHEMA_CAP;
  shown: number;
  truncated: boolean;
  errors: SspSchemaIssue[];
  groups: SspSchemaGroup[];
  artifact: { exportId: string; objectKey: string } | null;
  checkedAt: string;
};

function controlIdAt(document: unknown, instancePath: string): string | null {
  const parts = instancePath.split("/").filter(Boolean);
  let node: unknown = document;
  let controlId: string | null = null;
  for (const part of parts) {
    if (!node || typeof node !== "object") break;
    if (Array.isArray(node)) {
      const index = Number(part);
      if (!Number.isInteger(index)) break;
      node = node[index];
    } else {
      node = (node as Record<string, unknown>)[part];
    }
    if (node && typeof node === "object" && !Array.isArray(node)) {
      const id = (node as Record<string, unknown>)["control-id"];
      if (typeof id === "string" && id.trim()) controlId = id;
    }
  }
  return controlId;
}

/** A fix is returned only when the keyword and path name the change. Otherwise null. */
function fixFor(error: ErrorObject): string | null {
  const params = error.params ?? {};
  const where = error.instancePath || "/";
  if (error.keyword === "required" && typeof params.missingProperty === "string") {
    return `Add the required property ${params.missingProperty} at ${where}.`;
  }
  if (error.keyword === "additionalProperties" && typeof params.additionalProperty === "string") {
    return `Remove ${params.additionalProperty}, which is not in the SSP schema, at ${where}.`;
  }
  if (error.keyword === "type" && typeof params.type === "string") {
    return `Use a ${params.type} value at ${where}.`;
  }
  if (error.keyword === "format" && typeof params.format === "string") {
    return `Use a valid ${params.format} at ${where}.`;
  }
  if (error.keyword === "minItems") {
    return `Add at least one item at ${where}.`;
  }
  return null;
}

function issue(document: unknown, error: ErrorObject): SspSchemaIssue {
  const controlId = controlIdAt(document, error.instancePath || "");
  return {
    path: error.instancePath || "/",
    message: error.message ?? "invalid",
    keyword: error.keyword,
    controlId,
    group: controlId ?? `keyword:${error.keyword}`,
    fix: fixFor(error),
  };
}

export function sspSchemaReport(
  document: unknown,
  checkedAt: string,
  artifact: SspSchemaReport["artifact"] = null,
  root = findRepoRoot(),
): SspSchemaReport {
  const all = allSspSchemaErrors(document, root).map((error) => issue(document, error));
  const shownErrors = all.slice(0, SSP_SCHEMA_CAP);
  const groups = new Map<string, SspSchemaGroup>();
  for (const error of all) {
    const current = groups.get(error.group) ?? {
      key: error.group,
      label: error.controlId ?? error.keyword,
      controlId: error.controlId,
      count: 0,
      countShown: 0,
    };
    current.count += 1;
    groups.set(error.group, current);
  }
  for (const error of shownErrors) {
    const group = groups.get(error.group);
    if (group) group.countShown += 1;
  }
  return {
    schema: SSP_SCHEMA_ID,
    scope: SSP_SCHEMA_SCOPE,
    scopeNote: SSP_SCHEMA_SCOPE_NOTE,
    valid: all.length === 0,
    totalErrors: all.length,
    cap: SSP_SCHEMA_CAP,
    shown: shownErrors.length,
    truncated: all.length > SSP_SCHEMA_CAP,
    errors: shownErrors,
    groups: [...groups.values()],
    artifact,
    checkedAt,
  };
}

export function cappedSchemaErrors(document: unknown, root = findRepoRoot()): SspSchemaError[] {
  return sspSchemaReport(document, new Date(0).toISOString(), null, root).errors.map((error) => ({
    path: error.path,
    controlId: error.controlId,
    message: error.message,
  }));
}
