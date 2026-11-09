import {schemaValidator} from "../oscal/validate-schema";
import { readFileSync } from "node:fs";
import path from "node:path";
import Ajv, { type ErrorObject, type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import { AegisError } from "./errors";
import { roleIdsOf } from "./derive";
import { oscalControlId } from "./fixture";
import { findRepoRoot } from "./paths";
import { OSCAL_VERSION, stableUuid } from "./poam";
import { isUncoveredControl } from "./profile-resolution";
import type { ControlRecord, EvidenceRecord, ItemStatementRecord, PersistedState, Role } from "./types";

export const SSP_SCHEMA_PATH = ["schemas", "oscal", "1.1.2", "oscal_ssp_schema.json"] as const;

const PROFILE_HREF = "fixtures/rev5/fedramp-rev5-moderate-profile.json";
const IDENTIFIER_TYPE = "https://aegis.example/boundary";

export type SspSchemaError = {
  path: string;
  controlId: string | null;
  message: string;
};

type Json = Record<string, unknown>;

function sspValidator(root=findRepoRoot()):ValidateFunction{return schemaValidator("system-security-plan",root);}

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

/** Every schema error. Callers slice for the cap. A missing schema file throws SCHEMA_UNAVAILABLE. */
export function allSspSchemaErrors(document: unknown, root = findRepoRoot()): ErrorObject[] {
  const validate = sspValidator(root);
  if (validate(document)) return [];
  return [...(validate.errors ?? [])];
}

export function validatePackageSsp(document: unknown, root = findRepoRoot()): { ok: true } | { ok: false; errors: SspSchemaError[] } {
  const errors = allSspSchemaErrors(document, root).slice(0, 32).map((error: ErrorObject) => ({
    path: error.instancePath || "/",
    controlId: controlIdAt(document, error.instancePath || ""),
    message: error.message ?? "invalid",
  }));
  if (errors.length === 0) return { ok: true };
  return { ok: false, errors };
}

function roleEntry(role: Role): Json {
  const entry: Json = { id: role.id, title: role.title.trim() || role.id };
  const shortName = role.shortName?.trim();
  if (shortName) entry["short-name"] = shortName;
  return entry;
}

function statementExport(item: ItemStatementRecord, componentUuid: string, boundaryId: string, oscalId: string): Json | null {
  if (!/_smt\./i.test(item.statementId)) return null;
  const statement: Json = {
    "statement-id": item.statementId,
    uuid: item.uuid.trim() || stableUuid(`${boundaryId}:statement:${oscalId}:${item.statementId}`),
  };
  const description = item.description.trim();
  const links = item.evidenceUuids.filter((uuid) => uuid.trim()).map((uuid) => ({ href: `#${uuid}`, rel: "evidence" }));
  if (description) {
    const byComponent: Json = {
      "component-uuid": item.componentUuid.trim() || componentUuid,
      uuid: item.byComponentUuid.trim() || stableUuid(`${boundaryId}:statement-component:${oscalId}:${item.statementId}`),
      description,
    };
    if (links.length > 0) byComponent.links = links;
    statement["by-components"] = [byComponent];
  } else if (links.length > 0) {
    statement.links = links;
  }
  return statement;
}

function requirement(control: ControlRecord, componentUuid: string, boundaryId: string): Json {
  const oscalId = oscalControlId(control.id);
  const item: Json = {
    uuid: stableUuid(`${boundaryId}:requirement:${oscalId}`),
    "control-id": oscalId,
  };
  const roleIds = roleIdsOf(control);
  if (roleIds.length > 0) {
    item["responsible-roles"] = roleIds.map((roleId) => ({ "role-id": roleId }));
  }
  const statements = (control.itemStatements ?? [])
    .map((entry) => statementExport(entry, componentUuid, boundaryId, oscalId))
    .filter((entry): entry is Json => entry !== null);
  if (statements.length > 0) item.statements = statements;
  const implementation = control.implementation.trim();
  if (implementation) {
    item["by-components"] = [{
      "component-uuid": componentUuid,
      uuid: stableUuid(`${boundaryId}:by-component:${oscalId}`),
      description: implementation,
    }];
  }
  const links = control.evidence
    .filter((evidence) => evidence.href.trim() && evidence.uuid.trim())
    .map((evidence) => ({
      href: `#${evidence.uuid}`,
      rel: "evidence",
      text: evidence.title.trim() || evidence.id,
    }));
  if (links.length > 0) item.links = links;
  if (isUncoveredControl(control)) {
    item.remarks = "Uncovered. No implementation, role, or evidence is recorded.";
  }
  return item;
}

function resource(evidence: EvidenceRecord, controlIds: string[]): Json {
  return {
    uuid: evidence.uuid,
    title: evidence.title.trim() || evidence.id,
    props: [
      { name: "evidence-id", value: evidence.id },
      ...controlIds.map((id) => ({ name: "control-id", value: id })),
      { name: "type", value: evidence.type },
    ],
    rlinks: [{ href: evidence.href.trim() }],
  };
}

/**
 * OSCAL 1.1.2 JSON SSP for a package.
 * Control implementation text is written on the requirement's component entry.
 * Statement part text is written on that part's by-components entry, which is where this schema stores it.
 * The XML serializer is a separate download and is not this document.
 */
export function buildPackageSsp(state: PersistedState, now: Date): Json {
  if (!state.loaded || !state.boundaryId || !state.workspaceName) {
    throw new Error("Cannot export an empty workspace");
  }
  const boundaryId = state.boundaryId.trim();
  const name = state.workspaceName.trim();
  const sspUuid = stableUuid(`${boundaryId}:system-security-plan`);
  const componentUuid = stableUuid(`${boundaryId}:component`);
  const roles = state.roles.filter((role) => role.id.trim() && role.title.trim());
  const resources = new Map<string, { evidence: EvidenceRecord; controlIds: string[] }>();
  for (const control of state.controls) {
    const oscalId = oscalControlId(control.id);
    for (const evidence of control.evidence) {
      if (!evidence.uuid.trim() || !evidence.href.trim() || !evidence.id.trim()) continue;
      const current = resources.get(evidence.uuid) ?? { evidence, controlIds: [] };
      if (!current.controlIds.includes(oscalId)) current.controlIds.push(oscalId);
      resources.set(evidence.uuid, current);
    }
  }
  const metadata: Json = {
    title: name,
    "last-modified": now.toISOString(),
    version: "0.1.0",
    "oscal-version": OSCAL_VERSION,
    remarks: "Package export for the resolved FedRAMP Rev 5 Moderate profile. An uncovered control stays present and blank.",
  };
  if (roles.length > 0) metadata.roles = roles.map(roleEntry);
  const backMatter = resources.size > 0
    ? { resources: [...resources.values()].map((item) => resource(item.evidence, item.controlIds)) }
    : undefined;
  const document = {
    "system-security-plan": {
      uuid: sspUuid,
      metadata,
      "import-profile": {
        href: PROFILE_HREF,
        remarks: "Vendored FedRAMP Rev 5 Moderate profile resolved into this package.",
      },
      "system-characteristics": {
        "system-ids": [{ "identifier-type": IDENTIFIER_TYPE, id: boundaryId }],
        "system-name": name,
        description: `${name}. Profile membership is not an authorization.`,
        "security-sensitivity-level": "moderate",
        "system-information": {
          "information-types": [{
            title: "Package records",
            description: "Control implementation, roles, and evidence recorded in this package.",
          }],
        },
        "security-impact-level": {
          "security-objective-confidentiality": "moderate",
          "security-objective-integrity": "moderate",
          "security-objective-availability": "moderate",
        },
        status: { state: "operational" },
        "authorization-boundary": {
          description: `Authorization boundary ${boundaryId}.`,
        },
      },
      "system-implementation": {
        users: roles.length > 0
          ? roles.map((role) => ({
            uuid: stableUuid(`${sspUuid}:user:${role.id}`),
            title: role.title.trim(),
            "role-ids": [role.id],
          }))
          : [{ uuid: stableUuid(`${sspUuid}:user:reader`), title: "Package reader" }],
        components: [{
          uuid: componentUuid,
          type: "system",
          title: name,
          description: "System component for control implementation statements in this package.",
          status: { state: "operational" },
        }],
      },
      "control-implementation": {
        description: "Every control selected by the resolved profile. An uncovered control has no implementation statement.",
        "implemented-requirements": state.controls.map((control) => requirement(control, componentUuid, boundaryId)),
      },
      ...(backMatter ? { "back-matter": backMatter } : {}),
    },
  };
  carryUnmodeled(document["system-security-plan"] as Json, state.sourceSsp ?? null);
  return document;
}

const CARRIED_FIELDS: Array<{ path: string[]; reason: string }> = [
  {
    path: ["system-implementation", "leveraged-authorizations"],
    reason: "Leveraged authorizations are not a binder field. They are copied onto the JSON export when the source SSP has them.",
  },
  {
    path: ["system-implementation", "inventory-items"],
    reason: "Inventory items are not a binder field. They are copied onto the JSON export when the source SSP has them.",
  },
  {
    path: ["system-characteristics", "authorization-boundary", "diagrams"],
    reason: "Authorization boundary diagrams are not a binder field. They are copied onto the JSON export when the source SSP has them.",
  },
];

function readPath(source: Record<string, unknown>, keys: string[]): unknown {
  let current: unknown = source;
  for (const key of keys) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function writePath(target: Json, keys: string[], value: unknown): void {
  let dest: Json = target;
  for (let index = 0; index < keys.length - 1; index += 1) {
    const key = keys[index] ?? "";
    const next = dest[key];
    if (!next || typeof next !== "object" || Array.isArray(next)) dest[key] = {};
    dest = dest[key] as Json;
  }
  const leaf = keys[keys.length - 1] ?? "";
  if (dest[leaf] === undefined) dest[leaf] = value as Json[string];
}

/** Copy source fields the binder does not edit. Returns the paths that were present. */
export function carryUnmodeled(ssp: Json, source: Record<string, unknown> | null): Array<{ path: string; reason: string }> {
  const carried: Array<{ path: string; reason: string }> = [];
  if (!source) return carried;
  for (const field of CARRIED_FIELDS) {
    const value = readPath(source, field.path);
    if (value === undefined) continue;
    writePath(ssp, field.path, value);
    carried.push({ path: `/${field.path.join("/")}`, reason: field.reason });
  }
  const sourceImpl = readPath(source, ["control-implementation"]);
  const sourceReqs = sourceImpl && typeof sourceImpl === "object" && !Array.isArray(sourceImpl)
    ? (sourceImpl as Record<string, unknown>)["implemented-requirements"]
    : undefined;
  const builtImpl = ssp["control-implementation"];
  const builtReqs = builtImpl && typeof builtImpl === "object" && !Array.isArray(builtImpl)
    ? (builtImpl as Json)["implemented-requirements"]
    : undefined;
  if (!Array.isArray(sourceReqs) || !Array.isArray(builtReqs)) return carried;
  const byId = new Map<string, Record<string, unknown>>();
  for (const item of sourceReqs) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const id = (item as Record<string, unknown>)["control-id"];
    if (typeof id === "string" && id.trim()) byId.set(id.toLowerCase(), item as Record<string, unknown>);
  }
  for (const requirement of builtReqs) {
    if (!requirement || typeof requirement !== "object" || Array.isArray(requirement)) continue;
    const built = requirement as Json;
    const id = typeof built["control-id"] === "string" ? built["control-id"].toLowerCase() : "";
    const from = byId.get(id);
    if (!from) continue;
    if (from["set-parameters"] !== undefined && built["set-parameters"] === undefined) {
      built["set-parameters"] = from["set-parameters"] as Json[string];
      carried.push({
        path: `/control-implementation/implemented-requirements[control-id=${id}]/set-parameters`,
        reason: "Parameter settings on the source requirement are not edited by the binder. They are copied onto the JSON export.",
      });
    }
    const fromComponents = Array.isArray(from["by-components"]) ? from["by-components"] as Record<string, unknown>[] : [];
    const builtComponents = Array.isArray(built["by-components"]) ? built["by-components"] as Json[] : [];
    const sourceComponent = fromComponents[0];
    const builtComponent = builtComponents[0];
    if (!sourceComponent || !builtComponent) continue;
    for (const key of ["implementation-status", "export", "inherited"] as const) {
      if (sourceComponent[key] !== undefined && builtComponent[key] === undefined) {
        builtComponent[key] = sourceComponent[key] as Json[string];
        carried.push({
          path: `/control-implementation/implemented-requirements[control-id=${id}]/by-components/${key}`,
          reason: key === "export" || key === "inherited"
            ? "Common control provider and inheritance entries are not binder fields. They are copied onto the JSON export."
            : "implementation-status is not a binder field. It is copied onto the JSON export when the source requirement has it.",
        });
      }
    }
  }
  return carried;
}

export function unmodeledCarryReasons(): Array<{ path: string; reason: string }> {
  return CARRIED_FIELDS.map((field) => ({ path: `/${field.path.join("/")}`, reason: field.reason }));
}

/** Paths on a source SSP that the JSON export copies and the binder does not edit. */
export function carriedThroughFrom(source: Record<string, unknown> | null | undefined): Array<{ path: string; reason: string }> {
  if (!source) return [];
  const carried: Array<{ path: string; reason: string }> = [];
  for (const field of CARRIED_FIELDS) {
    if (readPath(source, field.path) !== undefined) carried.push({ path: `/${field.path.join("/")}`, reason: field.reason });
  }
  const impl = readPath(source, ["control-implementation"]);
  const reqs = impl && typeof impl === "object" && !Array.isArray(impl)
    ? (impl as Record<string, unknown>)["implemented-requirements"]
    : undefined;
  if (!Array.isArray(reqs)) return carried;
  for (const item of reqs) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const id = typeof record["control-id"] === "string" ? record["control-id"].toLowerCase() : "";
    if (!id) continue;
    if (record["set-parameters"] !== undefined) {
      carried.push({
        path: `/control-implementation/implemented-requirements[control-id=${id}]/set-parameters`,
        reason: "Parameter settings on the source requirement are not edited by the binder. They are copied onto the JSON export.",
      });
    }
    const components = Array.isArray(record["by-components"]) ? record["by-components"] as Record<string, unknown>[] : [];
    const component = components[0];
    if (!component) continue;
    if (component["implementation-status"] !== undefined) {
      carried.push({
        path: `/control-implementation/implemented-requirements[control-id=${id}]/by-components/implementation-status`,
        reason: "implementation-status is not a binder field. It is copied onto the JSON export when the source requirement has it.",
      });
    }
    if (component["export"] !== undefined || component["inherited"] !== undefined) {
      carried.push({
        path: `/control-implementation/implemented-requirements[control-id=${id}]/by-components/export`,
        reason: "Common control provider and inheritance entries are not binder fields. They are copied onto the JSON export.",
      });
    }
  }
  return carried;
}
