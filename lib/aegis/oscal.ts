import { randomUUID } from "node:crypto";
import { XMLParser } from "fast-xml-parser";
import { pinForCatalog } from "./catalogs";
import { roleTitle } from "./evidence";
import { oscalControlId } from "./fixture";
import { roleIdsOf } from "./derive";
import type { ControlRecord, ItemStatementRecord, PersistedState, ValidationError } from "./types";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export type SerializeOptions = {
  now: Date;
  /** RED sample: drop last-modified, force AC-2 role-id iam-admin, break the AC-2 evidence uuid. */
  defects?: boolean;
};

function rlinkLines(href: string, sha256?: string): string[] {
  if (!sha256) return [`      <rlink href="${xmlEscape(href)}"/>`];
  return [
    `      <rlink href="${xmlEscape(href)}">`,
    `        <hash algorithm="SHA-256">${xmlEscape(sha256)}</hash>`,
    `      </rlink>`,
  ];
}

function statementLines(item: ItemStatementRecord): string[] {
  const lines = [
    `      <statement statement-id="${xmlEscape(item.statementId)}"${item.uuid ? ` uuid="${xmlEscape(item.uuid)}"` : ""}>`,
  ];
  if (item.description || item.byComponentUuid || item.evidenceUuids.length > 0) {
    lines.push(`        <by-components>`);
    lines.push(`          <by-component${item.componentUuid ? ` component-uuid="${xmlEscape(item.componentUuid)}"` : ""}${item.byComponentUuid ? ` uuid="${xmlEscape(item.byComponentUuid)}"` : ""}>`);
    lines.push(`            <description>${xmlEscape(item.description)}</description>`);
    lines.push(`            <implementation-status state="implemented"/>`);
    for (const uuid of item.evidenceUuids) {
      lines.push(`            <link rel="evidence" href="#${xmlEscape(uuid)}"/>`);
    }
    lines.push(`          </by-component>`);
    lines.push(`        </by-components>`);
  }
  lines.push(`      </statement>`);
  return lines;
}

export function serializeOscal(state: PersistedState, options: SerializeOptions): string {
  if (!state.loaded || !state.boundaryId || !state.catalogPin || !state.workspaceName) {
    throw new Error("Cannot serialize an empty workspace");
  }
  const defects = options.defects === true;
  const sspUuid = randomUUID();
  const lines: string[] = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<system-security-plan xmlns="http://csrc.nist.gov/ns/oscal/1.0" uuid="${sspUuid}">`,
    `  <metadata>`,
    `    <title>${xmlEscape(state.workspaceName)}</title>`,
  ];
  if (!defects) {
    lines.push(`    <last-modified>${options.now.toISOString()}</last-modified>`);
  }
  lines.push(
    `    <version>0.1.0</version>`,
    `    <oscal-version>1.1.2</oscal-version>`,
    `    <roles>`,
  );
  for (const role of state.roles) {
    const shortName = role.shortName?.trim();
    lines.push(
      `      <role id="${xmlEscape(role.id)}">`,
      `        <title>${xmlEscape(role.title)}</title>`,
      ...(shortName ? [`        <short-name>${xmlEscape(shortName)}</short-name>`] : []),
      `      </role>`,
    );
  }
  lines.push(`    </roles>`, `  </metadata>`);
  lines.push(`  <import-profile href="${xmlEscape(state.catalogPin)}"/>`);
  lines.push(
    `  <system-characteristics>`,
    `    <system-id identifier-type="https://aegis.example/boundary">${xmlEscape(state.boundaryId)}</system-id>`,
    `    <system-name>${xmlEscape(state.workspaceName)}</system-name>`,
    `    <description>${xmlEscape(state.workspaceName)}. Catalog pin is read only.</description>`,
    `    <security-sensitivity-level>moderate</security-sensitivity-level>`,
    `    <system-information>`,
    `      <information-type>`,
    `        <title>Package metadata</title>`,
    `        <description>Subset fixture for the OSCAL binder harness.</description>`,
    `        <categorization>`,
    `          <system>https://doi.org/10.6028/NIST.SP.800-60v2r1</system>`,
    `          <information-type-id>C.3.5.1</information-type-id>`,
    `        </categorization>`,
    `      </information-type>`,
    `    </system-information>`,
    `    <security-impact-level>`,
    `      <security-objective-confidentiality>moderate</security-objective-confidentiality>`,
    `      <security-objective-integrity>moderate</security-objective-integrity>`,
    `      <security-objective-availability>moderate</security-objective-availability>`,
    `    </security-impact-level>`,
    `    <status state="operational"/>`,
    `    <authorization-boundary>`,
    `      <description>Authorization boundary ${xmlEscape(state.boundaryId)}.</description>`,
    `    </authorization-boundary>`,
    `  </system-characteristics>`,
  );

  const firstRole = state.roles[0]?.id ?? "csp-iam-administrator";
  lines.push(
    `  <system-implementation>`,
    `    <user uuid="${randomUUID()}">`,
    `      <title>CSP operator</title>`,
    `      <role-id>${xmlEscape(firstRole)}</role-id>`,
    `    </user>`,
  );
  for (const role of state.roles) {
    lines.push(
      `    <user uuid="${randomUUID()}">`,
      `      <title>${xmlEscape(role.title)}</title>`,
      `      <role-id>${xmlEscape(role.id)}</role-id>`,
      `    </user>`,
    );
  }
  lines.push(
    `    <component uuid="${randomUUID()}" type="system">`,
    `      <title>${xmlEscape(state.workspaceName)}</title>`,
    `      <description>In-scope system for the sample package.</description>`,
    `      <status state="operational"/>`,
    `    </component>`,
    `  </system-implementation>`,
    `  <control-implementation>`,
    `    <description>Implemented requirements for ${xmlEscape(state.catalogPin)}.</description>`,
  );

  for (const control of state.controls) {
    const oscalId = oscalControlId(control.id);
    const roleIds = defects && control.id === "AC-2" ? ["iam-admin"] : roleIdsOf(control);
    const items = control.itemStatements ?? [];
    const whole = items.find((item) => item.statementId.toLowerCase() === `${oscalId}_smt`);
    lines.push(`    <implemented-requirement control-id="${oscalId}">`);
    for (const roleId of roleIds) {
      lines.push(`      <responsible-role role-id="${xmlEscape(roleId)}"/>`);
    }
    lines.push(`      <statement statement-id="${oscalId}_smt"${whole?.uuid ? ` uuid="${xmlEscape(whole.uuid)}"` : ""}>`);
    lines.push(`        <description>${xmlEscape(control.implementation)}</description>`);
    if (whole) {
      for (const uuid of whole.evidenceUuids) {
        lines.push(`        <link rel="evidence" href="#${xmlEscape(uuid)}"/>`);
      }
    }
    lines.push(`      </statement>`);
    for (const item of items) {
      if (item.statementId.toLowerCase() === `${oscalId}_smt`) continue;
      lines.push(...statementLines(item));
    }
    for (const item of control.evidence) {
      if (!defects || control.id !== "AC-2") {
        lines.push(`      <link rel="evidence" href="#${item.uuid}"/>`);
      }
    }
    lines.push(`    </implemented-requirement>`);
  }
  lines.push(`  </control-implementation>`, `  <back-matter>`);

  let brokeAc2 = false;
  const emitted = new Set<string>();
  for (const control of state.controls) {
    control.evidence.forEach((item, index) => {
      const breakUuid = defects && control.id === "AC-2" && index === 0 && !brokeAc2;
      if (breakUuid) brokeAc2 = true;
      const uuid = breakUuid ? "not-a-uuid" : item.uuid;
      if (!breakUuid && emitted.has(item.uuid)) return;
      emitted.add(item.uuid);
      const controlIds = state.controls
        .filter((candidate) => candidate.evidence.some((evidence) => evidence.uuid === item.uuid))
        .map((candidate) => oscalControlId(candidate.id));
      lines.push(
        `    <resource uuid="${xmlEscape(uuid)}" title="${xmlEscape(item.title)}">`,
        `      <prop name="evidence-id" value="${xmlEscape(item.id)}"/>`,
        ...controlIds.map((id) => `      <prop name="control-id" value="${xmlEscape(id)}"/>`),
        `      <prop name="type" value="${xmlEscape(item.type)}"/>`,
        ...rlinkLines(item.href, item.sha256),
        `    </resource>`,
      );
    });
  }
  if (defects && !brokeAc2) {
    lines.push(
      `    <resource uuid="not-a-uuid" title="Quarterly account review">`,
      `      <prop name="evidence-id" value="EV-AC2-01"/>`,
      `      <prop name="control-id" value="ac-2"/>`,
      `      <prop name="type" value="Document"/>`,
      `      <rlink href="evidence/ac-2/iam-review-2026-08.pdf"/>`,
      `    </resource>`,
    );
  }
  lines.push(`  </back-matter>`, `</system-security-plan>`, ``);
  return lines.join("\n");
}

type XmlNode = Record<string, unknown>;

function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function textOf(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (value && typeof value === "object" && "#text" in value) {
    return textOf((value as Record<string, unknown>)["#text"]);
  }
  return "";
}

function propValue(resource: XmlNode, name: string): string {
  for (const prop of asArray(resource.prop as XmlNode | XmlNode[] | undefined)) {
    if (prop["@_name"] === name) return textOf(prop["@_value"]);
  }
  return "";
}

export function validateOscalXml(xml: string, state: PersistedState): ValidationError[] {
  const errors: ValidationError[] = [];
  let doc: XmlNode;
  try {
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "@_",
      ignoreDeclaration: true,
      parseTagValue: false,
      trimValues: true,
      isArray: (tagName) =>
        ["role", "implemented-requirement", "resource", "prop", "responsible-role", "rlink", "link"].includes(tagName),
    });
    doc = parser.parse(xml) as XmlNode;
  } catch {
    return [
      {
        id: "E1",
        check: "Schema",
        message: "OSCAL XML is not well-formed",
        oscalPath: "/",
        sourceInIr: "serializer",
      },
    ];
  }

  const ssp = (doc["system-security-plan"] ?? null) as XmlNode | null;
  if (!ssp) {
    errors.push({
      id: "E1",
      check: "Schema",
      message: "Root element system-security-plan is missing",
      oscalPath: "/system-security-plan",
      sourceInIr: "serializer",
    });
    return numberErrors(errors);
  }

  const metadata = (ssp.metadata ?? {}) as XmlNode;
  const lastModified = textOf(metadata["last-modified"]).trim();
  if (!lastModified) {
    errors.push({
      id: "E1",
      check: "Schema",
      message: "Required element last-modified is missing",
      oscalPath: "metadata/last-modified",
      sourceInIr: "Workspace metadata",
      hint: "fix in serializer",
    });
  }

  const rolesNode = (metadata.roles ?? {}) as XmlNode;
  const roleIds = new Set(
    asArray(rolesNode.role as XmlNode | XmlNode[] | undefined)
      .map((role) => textOf(role["@_id"]))
      .filter(Boolean),
  );

  const implementation = (ssp["control-implementation"] ?? {}) as XmlNode;
  const requirements = asArray(implementation["implemented-requirement"] as XmlNode | XmlNode[] | undefined);
  for (const requirement of requirements) {
    const oscalId = textOf(requirement["@_control-id"]);
    const displayId = oscalId.toUpperCase();
    for (const responsible of asArray(requirement["responsible-role"] as XmlNode | XmlNode[] | undefined)) {
      const roleId = textOf(responsible["@_role-id"]);
      if (!roleId || !roleIds.has(roleId)) {
        errors.push({
          id: "",
          check: "Schema",
          message: `role-id ${roleId || "(empty)"} has no matching role`,
          oscalPath: `…/implemented-requirement[${oscalId}]/responsible-role/@role-id`,
          sourceInIr: `${displayId} · responsibleRole`,
        });
      }
    }
  }

  const backMatter = (ssp["back-matter"] ?? {}) as XmlNode;
  for (const resource of asArray(backMatter.resource as XmlNode | XmlNode[] | undefined)) {
    const uuid = textOf(resource["@_uuid"]);
    if (!UUID_RE.test(uuid)) {
      const evidenceId = propValue(resource, "evidence-id");
      const controlId = propValue(resource, "control-id").toUpperCase();
      const source = evidenceId && controlId ? `${controlId} · ${evidenceId}` : "back-matter resource";
      errors.push({
        id: "",
        check: "Profile",
        message: "back-matter resource uuid is not a valid UUID",
        oscalPath: "back-matter/resource/@uuid",
        sourceInIr: source,
      });
    }
  }

  const characteristics = (ssp["system-characteristics"] ?? {}) as XmlNode;
  const systemId = textOf(characteristics["system-id"]);
  if (state.boundaryId && systemId !== state.boundaryId) {
    errors.push({
      id: "",
      check: "Profile",
      message: `system-id ${systemId || "(missing)"} does not match ${state.boundaryId}`,
      oscalPath: "system-characteristics/system-id",
      sourceInIr: "Workspace boundary",
    });
  }

  const profile = (ssp["import-profile"] ?? {}) as XmlNode;
  const profileHref = textOf(profile["@_href"]);
  const expectedPin = state.catalogId ? pinForCatalog(state.catalogId) : state.catalogPin;
  if (state.catalogId && state.catalogPin && expectedPin && state.catalogPin !== expectedPin) {
    errors.push({
      id: "",
      check: "Profile",
      message: `Active pin ${state.catalogPin} is not the ${state.catalogId} pin ${expectedPin}`,
      oscalPath: "import-profile/@href",
      sourceInIr: "Catalog pin",
    });
  }
  if (expectedPin && profileHref !== expectedPin) {
    errors.push({
      id: "",
      check: "Profile",
      message: `import-profile does not match read-only pin ${expectedPin}`,
      oscalPath: "import-profile/@href",
      sourceInIr: "Catalog pin",
    });
  }

  const expected = new Set(state.controls.map((control: ControlRecord) => oscalControlId(control.id)));
  const seen = new Set(requirements.map((requirement) => textOf(requirement["@_control-id"])));
  for (const id of expected) {
    if (!seen.has(id)) {
      errors.push({
        id: "",
        check: "Profile",
        message: `Implemented requirement ${id} is missing`,
        oscalPath: `control-implementation/implemented-requirement[${id}]`,
        sourceInIr: id.toUpperCase(),
      });
    }
  }

  return numberErrors(errors);
}

function numberErrors(errors: ValidationError[]): ValidationError[] {
  return errors.map((error, index) => ({ ...error, id: `E${index + 1}` }));
}

export function validationStatus(errors: ValidationError[]): "GREEN" | "RED" {
  return errors.length === 0 ? "GREEN" : "RED";
}

export function roleLabel(state: PersistedState, roleId: string): string {
  return roleTitle(state.roles, roleId);
}
