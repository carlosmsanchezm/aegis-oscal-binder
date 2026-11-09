import { catalogForPin } from "./catalogs";
import { rev5StatementItems } from "./map-graph";
import { profileControlIds } from "./profile-counts";
import { referencesModerateProfile } from "./profile-resolution";
import type { CatalogId } from "./types";

export const IMPORT_PROBLEM_CAP = 32;

export const IMPORT_PROBLEM_KINDS = [
  "unsupported profile",
  "missing required property",
  "unknown control id",
  "bad statement id",
  "broken reference",
] as const;

export type ImportProblemKind = (typeof IMPORT_PROBLEM_KINDS)[number];

export type ImportProblem = {
  kind: ImportProblemKind;
  path: string;
  message: string;
  fix: string | null;
};

export type ImportProblemReport = {
  cap: typeof IMPORT_PROBLEM_CAP;
  total: number;
  shown: number;
  truncated: boolean;
  stored: false;
  workspaceUnchanged: true;
  problems: ImportProblem[];
  groups: Array<{ key: ImportProblemKind; label: string; count: number; countShown: number }>;
};

const KIND_LABEL: Record<ImportProblemKind, string> = {
  "unsupported profile": "Unsupported profile",
  "missing required property": "Missing required property",
  "unknown control id": "Unknown control id",
  "bad statement id": "Bad statement id",
  "broken reference": "Broken reference",
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value == null) return [];
  return [value];
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function fixFor(kind: ImportProblemKind, path: string, detail: string): string {
  if (kind === "unsupported profile") {
    return `Point import-profile at the selected catalog pin or the vendored FedRAMP Rev 5 Moderate profile. ${path}`;
  }
  if (kind === "missing required property") return `Add the required property at ${path}.`;
  if (kind === "unknown control id") return `${detail} is not in the resolved profile. Use a control id from that profile.`;
  if (kind === "bad statement id") return detail;
  return `The reference at ${path} does not match an id in this file. Point it at an id that exists, or add that id.`;
}

function problem(kind: ImportProblemKind, path: string, message: string, detail = ""): ImportProblem {
  return { kind, path, message, fix: fixFor(kind, path, detail) };
}

export function reportImportProblems(problems: ImportProblem[]): ImportProblemReport {
  const shown = problems.slice(0, IMPORT_PROBLEM_CAP);
  const groups = IMPORT_PROBLEM_KINDS.flatMap((kind) => {
    const count = problems.filter((item) => item.kind === kind).length;
    if (count === 0) return [];
    return [{
      key: kind,
      label: KIND_LABEL[kind],
      count,
      countShown: shown.filter((item) => item.kind === kind).length,
    }];
  });
  return {
    cap: IMPORT_PROBLEM_CAP,
    total: problems.length,
    shown: shown.length,
    truncated: problems.length > IMPORT_PROBLEM_CAP,
    stored: false,
    workspaceUnchanged: true,
    problems: shown,
    groups,
  };
}

function sspOf(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const root = asRecord(parsed);
    return root ? asRecord(root["system-security-plan"]) : null;
  } catch {
    return null;
  }
}

/**
 * Structural problems in an OSCAL JSON SSP.
 * Kinds other than bad statement id, broken reference, and missing required property
 * are reported and still follow the existing ingest error for a single mismatch.
 */
export function collectImportProblems(text: string, catalogId: CatalogId, root: string): ImportProblem[] {
  const ssp = sspOf(text);
  if (!ssp) return [];
  const problems: ImportProblem[] = [];
  const metadata = asRecord(ssp.metadata);
  const profile = asRecord(ssp["import-profile"]);
  const href = stringValue(profile?.href);
  const owner = href ? catalogForPin(href) : null;
  if (href && owner && owner !== catalogId) {
    problems.push(problem(
      "unsupported profile",
      "/system-security-plan/import-profile/href",
      `import-profile ${href} belongs to the other catalog.`,
    ));
  }
  if (!metadata || !stringValue(metadata.title)) {
    problems.push(problem(
      "missing required property",
      "/system-security-plan/metadata/title",
      "metadata.title is missing.",
    ));
  }
  const moderate = referencesModerateProfile(href);
  const profileIds = new Set(profileControlIds(root));
  const implementation = asRecord(ssp["system-implementation"]);
  const componentIds = new Set(asArray(implementation?.components ?? implementation?.component).flatMap((item) => {
    const record = asRecord(item);
    const id = stringValue(record?.uuid);
    return id ? [id] : [];
  }));
  const roleIds = new Set(asArray(metadata?.roles).flatMap((item) => {
    const record = asRecord(item);
    const nested = record ? asArray(record.role) : [];
    const rows = nested.length > 0 ? nested : [item];
    return rows.flatMap((row) => {
      const id = stringValue(asRecord(row)?.id);
      return id ? [id] : [];
    });
  }));
  const back = asRecord(ssp["back-matter"]);
  const resourceIds = new Set(asArray(back?.resources ?? back?.resource).flatMap((item) => {
    const id = stringValue(asRecord(item)?.uuid);
    return id ? [id] : [];
  }));
  const controlImpl = asRecord(ssp["control-implementation"]);
  const requirements = asArray(controlImpl?.["implemented-requirements"] ?? controlImpl?.["implemented-requirement"]);
  requirements.forEach((requirement, index) => {
    const record = asRecord(requirement);
    const base = `/system-security-plan/control-implementation/implemented-requirements/${index}`;
    if (!record) return;
    const controlId = stringValue(record["control-id"]);
    if (!controlId) {
      problems.push(problem("missing required property", `${base}/control-id`, "control-id is missing."));
      return;
    }
    if (moderate && !profileIds.has(controlId.toLowerCase())) {
      problems.push(problem(
        "unknown control id",
        `${base}/control-id`,
        `${controlId} is not selected by the FedRAMP Rev 5 Moderate profile.`,
        controlId,
      ));
    }
    const known = rev5StatementItems(root, controlId);
    const rootStatement = `${controlId.toLowerCase()}_smt`;
    const allowed = new Set([rootStatement, ...known.map((item) => item.id.toLowerCase())]);
    asArray(record.statements ?? record.statement).forEach((statement, statementIndex) => {
      const row = asRecord(statement);
      const statementPath = `${base}/statements/${statementIndex}`;
      if (!row) return;
      const statementId = stringValue(row["statement-id"]);
      if (!statementId) {
        problems.push(problem("missing required property", `${statementPath}/statement-id`, "statement-id is missing."));
        return;
      }
      if (known.length > 0 && !allowed.has(statementId.toLowerCase())) {
        const listed = known.map((item) => item.id).join(", ");
        problems.push(problem(
          "bad statement id",
          `${statementPath}/statement-id`,
          `${statementId} is not a statement part of ${controlId}.`,
          `${statementId} does not exist. Valid part ids: ${listed}.`,
        ));
      }
    });
    const roles = asArray(record["responsible-roles"] ?? record["responsible-role"]);
    roles.forEach((role, roleIndex) => {
      const roleId = stringValue(asRecord(role)?.["role-id"]);
      if (roleId && !roleIds.has(roleId)) {
        problems.push(problem(
          "broken reference",
          `${base}/responsible-roles/${roleIndex}/role-id`,
          `role-id ${roleId} is not in metadata roles.`,
        ));
      }
    });
    const components = asArray(record["by-components"] ?? record["by-component"]);
    components.forEach((component, componentIndex) => {
      const componentId = stringValue(asRecord(component)?.["component-uuid"]);
      if (componentId && !componentIds.has(componentId)) {
        problems.push(problem(
          "broken reference",
          `${base}/by-components/${componentIndex}/component-uuid`,
          `component-uuid ${componentId} is not in system-implementation.`,
        ));
      }
    });
    for (const link of asArray(record.links ?? record.link)) {
      const hrefValue = stringValue(asRecord(link)?.href);
      if (hrefValue.startsWith("#") && !resourceIds.has(hrefValue.slice(1))) {
        problems.push(problem(
          "broken reference",
          `${base}/links`,
          `${hrefValue} does not match a back-matter resource.`,
        ));
      }
    }
  });
  return problems;
}

export function enforceableImportProblems(problems: ImportProblem[]): ImportProblem[] {
  return problems.filter((item) => item.kind === "bad statement id" || item.kind === "broken reference" || item.kind === "missing required property");
}
