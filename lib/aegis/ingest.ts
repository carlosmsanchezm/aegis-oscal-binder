import path from "node:path";
import {oscalMapMetadata} from "./oscal-map-metadata";
import { XMLParser } from "fast-xml-parser";
import { catalogForPin, loadCatalog, requireCatalogId } from "./catalogs";
import { AegisError } from "./errors";
import { roleIdsOf } from "./derive";
import { referencesModerateProfile, resolveModerateProfile } from "./profile-resolution";
import { canonicalEvidenceType, newEvidenceUuid, nextEvidenceId } from "./evidence";
import { emptyPersisted } from "./operations";
import type { CatalogId, ControlRecord, Ctx, IngestKind, ItemStatementRecord, PersistedState, Role } from "./types";

const MAX_CHARS = 2_000_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const XML_ARRAY_TAGS = new Set([
  "role",
  "system-id",
  "implemented-requirement",
  "responsible-role",
  "statement",
  "by-component",
  "link",
  "resource",
  "prop",
  "rlink",
  "hash",
  "p",
]);

type DraftResource = {
  uuid: string;
  title: string;
  type: string;
  href: string;
  sha256: string;
  evidenceId: string;
  controlId: string;
};

type DraftRequirement = Pick<ControlRecord,"providerCoverage"|"implementedBy"> & {
  controlId: string;
  roleIds: string[];
  parts: string[];
  links: string[];
  itemStatements: ItemStatementRecord[];
};

type SspDraft = {
  title: string;
  systemName: string;
  boundaryId: string;
  profileHref: string;
  roles: Role[];
  requirements: DraftRequirement[];
  resources: DraftResource[];
  statements: number;
  components: number;
};

export type IngestInput = {
  text: string;
  filename: string;
  catalogId: string;
};

function reject(message: string, code = "INGEST_REJECTED"): never {
  throw new AegisError(code, message, 400);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function prose(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value).trim();
  if (Array.isArray(value)) return joinProse(value.map(prose));
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length === 0) return "";
  if (keys.every((key) => key === "#text" || key.startsWith("@_"))) return prose(record["#text"]);
  const parts: string[] = [];
  for (const key of ["p", "li", "pre", "h1", "h2", "h3", "span", "#text"]) {
    if (key in record) parts.push(prose(record[key]));
  }
  return joinProse(parts);
}

function joinProse(parts: string[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out.join("\n\n");
}

function displayControlId(raw: string): string {
  return raw.trim().toUpperCase();
}

function familyOf(id: string): string {
  const prefix = id.split(".")[0]?.split("-")[0]?.trim();
  return prefix || "CTL";
}

function sniff(text: string): "json" | "xml" | "csv" | "unknown" {
  const trimmed = text.replace(/^\uFEFF/, "").trim();
  if (!trimmed) return "unknown";
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return "json";
  if (trimmed.startsWith("<")) return "xml";
  const head = trimmed.slice(0, 240).toLowerCase();
  if (head.includes("control_id") && head.includes(",")) return "csv";
  return "unknown";
}

function normalizeXml(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeXml);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const next: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(record)) {
    if (key.startsWith("@_")) {
      const name = key.slice(2);
      if (!(name in next)) next[name] = typeof child === "string" || typeof child === "number" ? String(child) : prose(child);
      continue;
    }
    next[key] = normalizeXml(child);
  }
  const keys = Object.keys(next);
  if (typeof next["#text"] === "string" && keys.every((key) => key === "#text")) return next["#text"];
  return next;
}

function rolesFrom(metadata: Record<string, unknown>): Role[] {
  const raw = metadata.roles;
  const items = Array.isArray(raw) ? raw : asArray(raw && typeof raw === "object" ? (raw as Record<string, unknown>).role : raw);
  const roles: Role[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const id = prose(record.id);
    if (!id || roles.some((role) => role.id === id)) continue;
    const shortName = prose(record["short-name"]);
    roles.push({ id, title: prose(record.title) || id, ...(shortName ? { shortName } : {}) });
  }
  return roles;
}

function systemIdOf(characteristics: Record<string, unknown>): string {
  const ids = asArray(characteristics["system-ids"] ?? characteristics["system-id"]);
  for (const item of ids) {
    if (typeof item === "string" && item.trim()) return item.trim();
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const id = prose(record.id) || prose(record["#text"]);
    if (id) return id;
  }
  return "";
}

function roleIdsOfRequirement(requirement: Record<string, unknown>): string[] {
  const raw = requirement["responsible-roles"] ?? requirement["responsible-role"];
  const nodes = asArray(raw).flatMap((item) => {
    if (item && typeof item === "object" && "responsible-role" in (item as Record<string, unknown>)) {
      return asArray((item as Record<string, unknown>)["responsible-role"]);
    }
    return [item];
  });
  const ids: string[] = [];
  for (const item of nodes) {
    if (typeof item === "string" && item.trim()) {
      if (!ids.includes(item.trim())) ids.push(item.trim());
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const roleId = prose((item as Record<string, unknown>)["role-id"]);
    if (roleId && !ids.includes(roleId)) ids.push(roleId);
  }
  return ids;
}

function componentNodes(record: Record<string, unknown>): Record<string, unknown>[] {
  const raw = record["by-components"] ?? record["by-component"];
  return asArray(raw).flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    if ("by-component" in row) {
      return asArray(row["by-component"]).flatMap((child) => (child && typeof child === "object" ? [child as Record<string, unknown>] : []));
    }
    if ("description" in row || "uuid" in row || "component-uuid" in row) return [row];
    return [];
  });
}

/** `ac-2_smt` is the control statement. `ac-2_smt.a` is an item. */
function wholeStatementId(statementId: string): boolean {
  return /_smt$/i.test(statementId);
}

function readRequirementBody(requirement: Record<string, unknown>): {
  parts: string[];
  itemStatements: ItemStatementRecord[];
} {
  const parts: string[] = [];
  const itemStatements: ItemStatementRecord[] = [];
  for (const statement of asArray(requirement.statements ?? requirement.statement)) {
    if (!statement || typeof statement !== "object") continue;
    const record = statement as Record<string, unknown>;
    const statementId = prose(record["statement-id"]);
    const description = prose(record.description);
    const components = componentNodes(record);
    const evidenceUuids = [...linkUuids(record)];
    let byDescription = "";
    let componentUuid = "";
    let byComponentUuid = "";
    for (const component of components) {
      if (!byDescription) byDescription = prose(component.description);
      if (!componentUuid) componentUuid = prose(component["component-uuid"]);
      if (!byComponentUuid) byComponentUuid = prose(component.uuid);
      for (const uuid of linkUuids(component)) {
        if (!evidenceUuids.includes(uuid)) evidenceUuids.push(uuid);
      }
    }
    if (wholeStatementId(statementId)) {
      if (description) parts.push(description);
      if (!description && byDescription) parts.push(byDescription);
      if (evidenceUuids.length > 0 || byDescription) {
        itemStatements.push({
          statementId,
          uuid: prose(record.uuid),
          description: byDescription,
          componentUuid,
          byComponentUuid,
          evidenceUuids,
        });
      }
      continue;
    }
    if (!statementId) continue;
    itemStatements.push({
      statementId,
      uuid: prose(record.uuid),
      description: byDescription || description,
      componentUuid,
      byComponentUuid,
      evidenceUuids,
    });
  }
  for (const component of componentNodes(requirement)) {
    const description = prose(component.description);
    if (description) parts.push(description);
  }
  return { parts, itemStatements };
}

function linkUuids(requirement: Record<string, unknown>): string[] {
  const uuids: string[] = [];
  for (const item of asArray(requirement.links ?? requirement.link)) {
    if (!item || typeof item !== "object") continue;
    const href = prose((item as Record<string, unknown>).href);
    if (href.startsWith("#")) uuids.push(href.slice(1));
  }
  return uuids;
}

function propValue(record: Record<string, unknown>, name: string): string {
  for (const item of asArray(record.props ?? record.prop)) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    if (prose(row.name) === name) return prose(row.value);
  }
  return "";
}

function digestText(value: unknown): string {
  const text = prose(value).toLowerCase();
  return /^[a-f0-9]{64}$/.test(text) ? text : "";
}

function digestFromLink(link: Record<string, unknown>): string {
  for (const hash of asArray(link.hashes ?? link.hash)) {
    if (!hash || typeof hash !== "object") continue;
    const row = hash as Record<string, unknown>;
    if (prose(row.algorithm).toUpperCase() !== "SHA-256") continue;
    const value = digestText(row.value) || digestText(row["#text"]);
    if (value) return value;
  }
  return "";
}

function firstLink(record: Record<string, unknown>): { href: string; sha256: string } {
  for (const item of asArray(record.rlinks ?? record.rlink)) {
    if (typeof item === "string" && item.trim()) return { href: item.trim(), sha256: "" };
    if (!item || typeof item !== "object") continue;
    const link = item as Record<string, unknown>;
    const href = prose(link.href);
    if (href) return { href, sha256: digestFromLink(link) };
  }
  return { href: "", sha256: "" };
}

function resourcesFrom(ssp: Record<string, unknown>): DraftResource[] {
  const back = asRecord(ssp["back-matter"]);
  const resources: DraftResource[] = [];
  for (const item of asArray(back.resources ?? back.resource)) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const link = firstLink(record);
    if (!link.href) continue;
    resources.push({
      uuid: prose(record.uuid),
      title: prose(record.title) || "Evidence",
      type: propValue(record, "type"),
      href: link.href,
      sha256: link.sha256,
      evidenceId: propValue(record, "evidence-id"),
      controlId: propValue(record, "control-id"),
    });
  }
  return resources;
}

function countStatements(ssp: Record<string, unknown>): number {
  const implementation = asRecord(ssp["control-implementation"]);
  const requirements = asArray(implementation["implemented-requirements"] ?? implementation["implemented-requirement"]);
  let count = 0;
  for (const item of requirements) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    count += asArray(record.statements ?? record.statement).length;
  }
  return count;
}

function countComponents(ssp: Record<string, unknown>): number {
  const implementation = asRecord(ssp["system-implementation"]);
  return asArray(implementation.components ?? implementation.component).filter((item) => item && typeof item === "object").length;
}

function sspToDraft(ssp: Record<string, unknown>): SspDraft {
  const metadata = asRecord(ssp.metadata);
  const characteristics = asRecord(ssp["system-characteristics"]);
  const profile = asRecord(ssp["import-profile"]);
  const implementation = asRecord(ssp["control-implementation"]);
  const requirements = asArray(implementation["implemented-requirements"] ?? implementation["implemented-requirement"]);
  return {
    title: prose(metadata.title),
    systemName: prose(characteristics["system-name"]),
    boundaryId: systemIdOf(characteristics),
    profileHref: prose(profile.href),
    roles: rolesFrom(metadata),
    statements: countStatements(ssp),
    components: countComponents(ssp),
    requirements: requirements.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const record = item as Record<string, unknown>;
      const controlId = prose(record["control-id"]);
      if (!controlId) return [];
      const body = readRequirementBody(record);
      return [{
        controlId,
        ...oscalMapMetadata(ssp,record),
        roleIds: roleIdsOfRequirement(record),
        parts: body.parts,
        links: linkUuids(record),
        itemStatements: body.itemStatements,
      }];
    }),
    resources: resourcesFrom(ssp),
  };
}

function parseJsonPackage(text: string): SspDraft {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    reject("OSCAL JSON is not valid JSON.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    reject("OSCAL JSON must be an object with a system-security-plan.");
  }
  const root = value as Record<string, unknown>;
  const ssp = root["system-security-plan"];
  if (!ssp || typeof ssp !== "object" || Array.isArray(ssp)) {
    if ("controls" in root && "catalogPin" in root) {
      reject("This JSON is the demo sample package IR, not an OSCAL system-security-plan. Use Load demo sample package for the offline demo.");
    }
    reject("OSCAL JSON must contain a system-security-plan object.");
  }
  return sspToDraft(ssp as Record<string, unknown>);
}

function parseXmlPackage(text: string): SspDraft {
  let doc: unknown;
  try {
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "@_",
      removeNSPrefix: true,
      ignoreDeclaration: true,
      parseTagValue: false,
      trimValues: true,
      isArray: (tagName) => XML_ARRAY_TAGS.has(tagName),
    });
    doc = parser.parse(text);
  } catch {
    reject("OSCAL XML is not well-formed.");
  }
  const root = asRecord(normalizeXml(doc));
  const ssp = root["system-security-plan"];
  if (!ssp || typeof ssp !== "object" || Array.isArray(ssp)) {
    reject("OSCAL XML must contain a system-security-plan element.");
  }
  return sspToDraft(ssp as Record<string, unknown>);
}

function parseOscal(text: string): SspDraft {
  const kind = sniff(text);
  if (kind === "csv") {
    reject("This file looks like a CSV control table. Use Upload CSV for machine-readable rows.");
  }
  if (kind === "json") return parseJsonPackage(text);
  if (kind === "xml") return parseXmlPackage(text);
  if (!text.trim()) reject("Upload is empty.");
  reject("Upload is not OSCAL JSON or XML.");
}

function ensureRole(roles: Role[], roleId: string): string {
  const trimmed = roleId.trim();
  if (!trimmed) return "";
  const existing = roles.find((role) => role.id === trimmed || role.title.toLowerCase() === trimmed.toLowerCase());
  if (existing) return existing.id;
  roles.push({ id: trimmed, title: trimmed });
  return trimmed;
}

function takeEvidenceId(control: ControlRecord, proposed: string): string {
  const trimmed = proposed.trim();
  if (/^EV-[A-Za-z0-9-]+$/.test(trimmed) && !control.evidence.some((item) => item.id.toLowerCase() === trimmed.toLowerCase())) {
    return trimmed.toUpperCase();
  }
  return nextEvidenceId(control);
}

function evidenceTypeFor(raw: string, href: string): ControlRecord["evidence"][number]["type"] {
  return canonicalEvidenceType(raw) ?? (href.trim().toLowerCase().startsWith("https://") ? "Link" : "Document");
}

function resourcesFor(requirement: DraftRequirement, resources: DraftResource[], controlId: string): DraftResource[] {
  const linked = new Set(requirement.links);
  const chosen: DraftResource[] = [];
  const seen = new Set<string>();
  const matches = (resource: DraftResource) => {
    if (resource.uuid && linked.has(resource.uuid)) return true;
    return displayControlId(resource.controlId) === controlId;
  };
  for (const resource of resources) {
    if (!matches(resource)) continue;
    const key = resource.uuid || `${resource.href}::${resource.title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    chosen.push(resource);
  }
  return chosen;
}

function controlsFromDraft(draft: SspDraft, catalogId: CatalogId, ctx: Ctx): { roles: Role[]; controls: ControlRecord[] } {
  const catalog = loadCatalog(ctx.root, catalogId);
  const roles = structuredClone(draft.roles);
  const controls: ControlRecord[] = [];
  for (const requirement of draft.requirements) {
    const id = displayControlId(requirement.controlId);
    if (!id) continue;
    const known = catalog.controls.find((item) => item.id.toUpperCase() === id);
    let control = controls.find((item) => item.id === id);
    if (!control) {
      control = {
        id,
        title: known?.title ?? id,
        family: known?.family ?? familyOf(id),
        implementation: "",
        responsibleRoleId: "",
        responsibleRoleIds: [],
        itemStatements: [],
        evidence: [],
      };
      controls.push(control);
    } else if (known) {
      control.title = known.title;
      control.family = known.family;
    }
    if(requirement.implementedBy)control.implementedBy=[...new Map([...(control.implementedBy??[]),...requirement.implementedBy].map(c=>[c.id,c])).values()];
    if(requirement.providerCoverage)control.providerCoverage=[...new Map([...(control.providerCoverage??[]),...requirement.providerCoverage].map(c=>[c.provider.id,c])).values()];
    control.implementation = joinProse([control.implementation, ...requirement.parts]);
    const roleIds = control.responsibleRoleIds ?? [];
    for (const roleId of requirement.roleIds) {
      const id = ensureRole(roles, roleId);
      if (id && !roleIds.includes(id)) roleIds.push(id);
    }
    control.responsibleRoleIds = roleIds;
    control.responsibleRoleId = roleIds[0] ?? "";
    const items = control.itemStatements ?? [];
    for (const item of requirement.itemStatements) {
      if (items.some((existing) => existing.statementId === item.statementId)) continue;
      items.push(item);
    }
    control.itemStatements = items;
    for (const resource of resourcesFor(requirement, draft.resources, id)) {
      const duplicate = control.evidence.some((item) => (resource.uuid && item.uuid === resource.uuid) || (item.href === resource.href && item.title === resource.title));
      if (duplicate) continue;
      const evidenceId = takeEvidenceId(control, resource.evidenceId);
      let title = resource.title.trim() || "Evidence";
      if (control.evidence.some((item) => item.title.toLowerCase() === title.toLowerCase())) {
        title = `${title} (${evidenceId})`;
      }
      const uuid = UUID_RE.test(resource.uuid) ? resource.uuid : newEvidenceUuid();
      control.evidence.push({
        id: evidenceId,
        title,
        type: evidenceTypeFor(resource.type, resource.href),
        href: resource.href.trim(),
        uuid,
        ...(resource.sha256 ? { sha256: resource.sha256 } : {}),
      });
    }
  }
  return { roles, controls };
}

function assertProfile(profileHref: string, catalogId: CatalogId): void {
  const href = profileHref.trim();
  if (!href) return;
  const owner = catalogForPin(href);
  if (!owner || owner === catalogId) return;
  const selected = catalogId === "fedramp-20x" ? "FedRAMP 20x" : "FedRAMP Rev5";
  const found = owner === "fedramp-20x" ? "FedRAMP 20x" : "FedRAMP Rev5";
  throw new AegisError(
    "CATALOG_MISMATCH",
    `This package imports ${href}, which is the ${found} baseline. Select ${found} and upload again. ${selected} is the catalog selected now.`,
    400,
  );
}

function workspaceFrom(draft: { systemName: string; title: string }, filename: string): string {
  return draft.systemName || draft.title || path.basename(filename, path.extname(filename)) || "Uploaded package";
}

function finish(
  draft: { systemName: string; title: string; boundaryId: string; profileHref: string },
  roles: Role[],
  controls: ControlRecord[],
  catalogId: CatalogId,
  kind: IngestKind,
  filename: string,
  ctx: Ctx,
): PersistedState {
  if (controls.length === 0) {
    reject(kind === "csv" ? "CSV has no control rows." : "No implemented requirements in this OSCAL package.");
  }
  const catalog = loadCatalog(ctx.root, catalogId);
  const next = emptyPersisted();
  next.loaded = true;
  next.catalogId = catalog.id;
  next.catalogPin = catalog.pin;
  next.ingestKind = kind;
  next.sourceFilename = path.basename(filename) || "upload";
  next.sourceProfileHref = draft.profileHref.trim() || null;
  next.workspaceName = workspaceFrom(draft, filename);
  next.boundaryId = draft.boundaryId.trim() || "bnd-upload";
  next.roles = roles;
  next.controls = controls;
  return next;
}

export function ingestOscalPackage(input: IngestInput, ctx: Ctx): PersistedState {
  const text = input.text.replace(/^\uFEFF/, "");
  if (text.length > MAX_CHARS) reject("Upload is larger than 2 MB.");
  const catalogId = requireCatalogId(input.catalogId);
  const draft = parseOscal(text);
  assertProfile(draft.profileHref, catalogId);
  if (draft.requirements.length === 0) reject("No implemented requirements in this OSCAL package.");
  const built = controlsFromDraft(draft, catalogId, ctx);
  const next = finish(draft, built.roles, built.controls, catalogId, "oscal", input.filename, ctx);
  const resolved = !referencesModerateProfile(draft.profileHref)
    ? next
    : catalogId !== "fedramp-rev5"
      ? (() => {
        throw new AegisError(
          "CATALOG_MISMATCH",
          "This package imports the FedRAMP Rev 5 Moderate profile. Select FedRAMP Rev5 and upload again.",
          400,
        );
      })()
      : resolveModerateProfile(next);
  resolved.importCensus = {
    bytes: Buffer.byteLength(text),
    filename: path.basename(input.filename) || "upload",
    controlsFound: draft.requirements.length,
    statements: draft.statements,
    components: draft.components,
    roles: draft.roles.length,
    evidenceResources: draft.resources.length,
  };
  resolved.importBaseline = resolved.controls.map((control) => ({
    id: control.id,
    implementation: control.implementation,
    responsibleRoleIds: roleIdsOf(control),
    evidence: control.evidence.map((item) => ({ id: item.id, title: item.title, href: item.href })),
    parts: (control.itemStatements ?? [])
      .filter((item) => /_smt\./i.test(item.statementId))
      .map((item) => ({ statementId: item.statementId, description: item.description, evidenceUuids: [...item.evidenceUuids] })),
  }));
  if (text.trim().startsWith("{")) {
    try {
      const parsed = JSON.parse(text) as { "system-security-plan"?: Record<string, unknown> };
      resolved.sourceSsp = parsed["system-security-plan"] ?? null;
    } catch {
      resolved.sourceSsp = null;
    }
  } else {
    resolved.sourceSsp = null;
  }
  return resolved;
}

type CsvRow = Record<string, string>;

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const source = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i] ?? "";
    if (quoted) {
      if (char === '"') {
        if (source[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === ",") {
      row.push(cell);
      cell = "";
      continue;
    }
    if (char === "\n") {
      row.push(cell);
      cell = "";
      if (row.some((item) => item.trim())) rows.push(row);
      row = [];
      continue;
    }
    cell += char;
  }
  row.push(cell);
  if (row.some((item) => item.trim())) rows.push(row);
  return rows;
}

function headerKey(value: string): string {
  const key = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  const aliases: Record<string, string> = {
    control_id: "controlId",
    controlid: "controlId",
    id: "controlId",
    implementation: "implementation",
    responsible_role: "role",
    responsible_role_id: "role",
    role: "role",
    role_id: "role",
    evidence_title: "evidenceTitle",
    title: "evidenceTitle",
    evidence_type: "evidenceType",
    type: "evidenceType",
    evidence_href: "evidenceHref",
    href: "evidenceHref",
    link: "evidenceHref",
    family: "family",
    control_title: "controlTitle",
  };
  return aliases[key] ?? "";
}

function rowsFromCsv(text: string): CsvRow[] {
  const table = parseCsv(text);
  const header = table[0];
  if (!header) reject("CSV is empty.");
  const keys = header.map(headerKey);
  if (!keys.includes("controlId")) {
    reject("CSV needs a control_id column. Expected columns: control_id, implementation, responsible_role, evidence_title, evidence_type, evidence_href.");
  }
  return table.slice(1).map((cells) => {
    const row: CsvRow = {};
    keys.forEach((key, index) => {
      if (!key) return;
      row[key] = (cells[index] ?? "").trim();
    });
    return row;
  }).filter((row) => row.controlId);
}

export function ingestCsvPackage(input: IngestInput, ctx: Ctx): PersistedState {
  const text = input.text.replace(/^\uFEFF/, "");
  if (text.length > MAX_CHARS) reject("Upload is larger than 2 MB.");
  const kind = sniff(text);
  if (kind === "json" || kind === "xml") {
    reject("This file looks like OSCAL. Use Upload OSCAL for a system-security-plan.");
  }
  if (!text.trim()) reject("Upload is empty.");
  const catalogId = requireCatalogId(input.catalogId);
  const catalog = loadCatalog(ctx.root, catalogId);
  const rows = rowsFromCsv(text);
  if (rows.length === 0) reject("CSV has no control rows.");
  const roles: Role[] = [];
  const controls: ControlRecord[] = [];
  for (const row of rows) {
    const id = displayControlId(row.controlId ?? "");
    if (!id) continue;
    const known = catalog.controls.find((item) => item.id.toUpperCase() === id);
    let control = controls.find((item) => item.id === id);
    if (!control) {
      control = {
        id,
        title: known?.title ?? (row.controlTitle?.trim() || id),
        family: known?.family ?? (row.family?.trim().toUpperCase() || familyOf(id)),
        implementation: "",
        responsibleRoleId: "",
        evidence: [],
      };
      controls.push(control);
    }
    if (row.implementation) control.implementation = joinProse([control.implementation, row.implementation]);
    if (row.role && !control.responsibleRoleId) control.responsibleRoleId = ensureRole(roles, row.role);
    if (row.evidenceHref || row.evidenceTitle) {
      const href = (row.evidenceHref ?? "").trim();
      const evidenceId = takeEvidenceId(control, "");
      let title = (row.evidenceTitle ?? "").trim() || "Evidence";
      if (control.evidence.some((item) => item.title.toLowerCase() === title.toLowerCase())) {
        title = `${title} (${evidenceId})`;
      }
      if (href) {
        control.evidence.push({
          id: evidenceId,
          title,
          type: evidenceTypeFor(row.evidenceType ?? "", href),
          href,
          uuid: newEvidenceUuid(),
        });
      }
    }
  }
  const filename = input.filename || "controls.csv";
  return finish(
    {
      systemName: path.basename(filename, path.extname(filename)) || "CSV import",
      title: "",
      boundaryId: "bnd-csv",
      profileHref: "",
    },
    roles,
    controls,
    catalogId,
    "csv",
    filename,
    ctx,
  );
}
