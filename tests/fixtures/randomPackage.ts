/**
 * Seeded OSCAL Rev5 SSP builder for upload tests.
 *
 * The document is produced without the app's ingest or map code. Tests parse
 * it back with `describePackage` and compare that to the UI and to the data
 * layer the map uses. A failure should name the seed so the case can be rerun.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

function repoRoot(): string {
  const fromFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const catalog = path.join(fromFile, "fixtures/rev5/NIST_SP-800-53_rev5_catalog-min.json");
  if (existsSync(catalog)) return fromFile;
  return process.cwd();
}

const ROOT = repoRoot();

export const UPLOAD_FIXTURE = "fixtures/upload/upload-test-ssp-rev5.json";
export const UPLOAD_PUBLIC = "public/upload/upload-test-ssp-rev5.json";
/** Served by Next from `public/`. */
export const UPLOAD_DOWNLOAD_PATH = "/upload/upload-test-ssp-rev5.json";

export const CATALOG_PIN = "fedramp-rev5-subset@2026.09";

/** Role ids on the 12-control Rev5 sample. A non-sample package must not invent these. */
export const SAMPLE_ROLE_IDS = ["system-owner", "isso", "system-admin", "secops", "identity-admin"] as const;

/** Control ids on the 12-control Rev5 sample. */
export const SAMPLE_CONTROL_IDS = [
  "AC-2",
  "AC-3",
  "AC-6",
  "AU-2",
  "AU-6",
  "CM-2",
  "CM-6",
  "IA-2",
  "IA-5",
  "SC-7",
  "SC-8",
  "SI-2",
] as const;

export const SAMPLE_FAMILIES = ["AC", "AU", "CM", "IA", "SC", "SI"] as const;

/**
 * Fixed seeds. Each one is a different shape:
 * - 2: seven roles and zero evidence
 * - 3: one role, with adjacent, non-adjacent, and single-family evidence
 * - 19: one family, one role, and zero evidence
 * - 48: six families and mixed evidence
 * - 64: six families, seven roles, and mixed evidence
 */
export const FIXED_SEEDS = [2, 3, 19, 48, 64] as const;

const ROLE_POOL: Array<{ id: string; title: string; shortName: string }> = [
  { id: "pkg-steward", title: "Package Steward", shortName: "Steward" },
  { id: "boundary-lead", title: "Boundary Lead", shortName: "Boundary" },
  { id: "evidence-clerk", title: "Evidence Clerk", shortName: "Clerk" },
  { id: "change-captain", title: "Change Captain", shortName: "Captain" },
  { id: "recovery-lead", title: "Recovery Lead", shortName: "Recovery" },
  { id: "audit-scribe", title: "Audit Scribe", shortName: "Scribe" },
  { id: "vendor-liaison", title: "Vendor Liaison", shortName: "Liaison" },
];

type Rng = () => number;

type CatalogControl = { id: string; title: string; family: string };

type CatalogIndex = {
  familyOrder: string[];
  byFamily: Map<string, CatalogControl[]>;
  /** Lowercase control id → lowercase related targets from the NIST catalog. */
  related: Map<string, string[]>;
};

export type RoleFact = {
  id: string;
  title: string;
  shortName: string;
  /** Text the map chip shows: short-name when set, otherwise the title. */
  label: string;
};

export type ControlFact = {
  id: string;
  family: string;
  implementation: string;
  roleIds: string[];
  evidenceUuids: string[];
  complete: boolean;
};

export type EvidenceFact = {
  uuid: string;
  id: string;
  title: string;
  href: string;
  controlIds: string[];
  families: string[];
  /** How this item sits on the package's family order. */
  span: "single" | "adjacent" | "non-adjacent";
};

export type PackageFacts = {
  systemName: string;
  boundaryId: string;
  roles: RoleFact[];
  controls: ControlFact[];
  families: string[];
  evidence: EvidenceFact[];
  incomplete: number;
  gateLabel: string;
};

type SspDocument = {
  "system-security-plan": Record<string, unknown>;
};

let catalogCache: CatalogIndex | null = null;

function catalogIndex(): CatalogIndex {
  if (catalogCache) return catalogCache;
  const file = path.join(ROOT, "fixtures/rev5/NIST_SP-800-53_rev5_catalog-min.json");
  const doc = JSON.parse(readFileSync(file, "utf8")) as {
    catalog?: {
      groups?: Array<{
        id?: string;
        controls?: Array<{ id?: string; title?: string; links?: Array<{ href?: string; rel?: string }> }>;
      }>;
    };
  };
  const familyOrder: string[] = [];
  const byFamily = new Map<string, CatalogControl[]>();
  const related = new Map<string, string[]>();
  for (const group of doc.catalog?.groups ?? []) {
    const family = (group.id ?? "").trim().toUpperCase();
    if (!family) continue;
    familyOrder.push(family);
    const controls: CatalogControl[] = [];
    for (const control of group.controls ?? []) {
      const raw = control.id?.trim() ?? "";
      if (!raw) continue;
      const id = raw.toLowerCase();
      const targets: string[] = [];
      for (const link of control.links ?? []) {
        if (link.rel !== "related" || !link.href) continue;
        const hash = link.href.includes("#") ? link.href.slice(link.href.lastIndexOf("#") + 1) : link.href;
        const target = hash.trim().toLowerCase();
        if (!/^[a-z]{2}-\d+(?:\.\d+)*$/.test(target) || target === id || targets.includes(target)) continue;
        targets.push(target);
      }
      related.set(id, targets);
      if (!/^[a-z]{2}-\d+$/i.test(raw)) continue;
      controls.push({
        id,
        title: control.title?.trim() || raw.toUpperCase(),
        family,
      });
    }
    byFamily.set(family, controls);
  }
  catalogCache = { familyOrder, byFamily, related };
  return catalogCache;
}

/** Other package controls the catalog lists as related to `controlId`, in either direction. */
export function relatedPeers(facts: PackageFacts, controlId: string): string[] {
  const catalog = catalogIndex();
  const inPackage = new Set(facts.controls.map((control) => control.id.toLowerCase()));
  const display = new Map(facts.controls.map((control) => [control.id.toLowerCase(), control.id]));
  const selected = controlId.toLowerCase();
  const peers = new Set<string>();
  for (const control of facts.controls) {
    const from = control.id.toLowerCase();
    for (const target of catalog.related.get(from) ?? []) {
      if (!inPackage.has(target)) continue;
      if (from === selected) peers.add(display.get(target)!);
      if (target === selected) peers.add(display.get(from)!);
    }
  }
  return [...peers].sort(compareControlId);
}

/** Mulberry32. Same seed, same sequence. */
export function mulberry32(seed: number): Rng {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function int(rng: Rng, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

function shuffle<T>(rng: Rng, items: readonly T[]): T[] {
  const next = [...items];
  for (let index = next.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(rng() * (index + 1));
    const current = next[index];
    next[index] = next[swap] as T;
    next[swap] = current as T;
  }
  return next;
}

function uuidFrom(rng: Rng): string {
  const nibbles = (count: number) => Array.from({ length: count }, () => Math.floor(rng() * 16).toString(16)).join("");
  const variant = (8 + Math.floor(rng() * 4)).toString(16);
  return `${nibbles(8)}-${nibbles(4)}-4${nibbles(3)}-${variant}${nibbles(3)}-${nibbles(12)}`;
}

function displayId(raw: string): string {
  return raw.trim().toUpperCase();
}

function familyOf(id: string): string {
  return id.split(".")[0]?.split("-")[0]?.trim().toUpperCase() || "CTL";
}

/** Same ordering the map uses for control ids (`lib/aegis/control-order.ts`). */
export function compareControlId(a: string, b: string): number {
  const parts = (id: string) => id.split(".").map((part, index) => (index === 0 ? part : Number(part)));
  const left = parts(a);
  const right = parts(b);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const aPart = left[index];
    const bPart = right[index];
    if (aPart === undefined) return -1;
    if (bPart === undefined) return 1;
    if (aPart === bPart) continue;
    if (typeof aPart === "number" && typeof bPart === "number") return aPart - bPart;
    return String(aPart).localeCompare(String(bPart));
  }
  return 0;
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
  if (Array.isArray(value)) return value.map(prose).filter(Boolean).join("\n\n");
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  if ("#text" in record) return prose(record["#text"]);
  return prose(record.p ?? record.description ?? "");
}

function hrefOk(href: string): boolean {
  const trimmed = href.trim();
  if (trimmed.startsWith("evidence/") || trimmed.startsWith("workspace-evidence/")) return !trimmed.includes("..");
  try {
    const url = new URL(trimmed);
    return url.protocol === "https:" && Boolean(url.hostname);
  } catch {
    return false;
  }
}

function spanOf(families: string[], packageFamilies: string[]): EvidenceFact["span"] {
  const indexes = [...new Set(families)]
    .map((id) => packageFamilies.indexOf(id))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b);
  if (indexes.length <= 1) return "single";
  const contiguous = indexes.every((value, index) => index === 0 || value === indexes[index - 1]! + 1);
  return contiguous ? "adjacent" : "non-adjacent";
}

/** Read a system-security-plan the way the map should, without calling ingest. */
export function describePackage(document: unknown): PackageFacts {
  const root = asRecord(document);
  const ssp = asRecord(root["system-security-plan"]);
  const metadata = asRecord(ssp.metadata);
  const characteristics = asRecord(ssp["system-characteristics"]);
  const implementation = asRecord(ssp["control-implementation"]);
  const catalog = catalogIndex();

  const roles: RoleFact[] = [];
  for (const item of asArray(metadata.roles)) {
    const record = asRecord(item);
    const id = prose(record.id);
    if (!id || roles.some((role) => role.id === id)) continue;
    const title = prose(record.title) || id;
    const shortName = prose(record["short-name"]);
    roles.push({ id, title, shortName, label: shortName || title });
  }

  const resources = asArray(asRecord(ssp["back-matter"]).resources).map((item) => {
    const record = asRecord(item);
    const href = asArray(record.rlinks).map((link) => prose(asRecord(link).href)).find(Boolean) ?? "";
    let evidenceId = "";
    let controlId = "";
    for (const prop of asArray(record.props)) {
      const row = asRecord(prop);
      if (prose(row.name) === "evidence-id") evidenceId = prose(row.value);
      if (prose(row.name) === "control-id" && !controlId) controlId = prose(row.value);
    }
    return {
      uuid: prose(record.uuid),
      id: evidenceId,
      title: prose(record.title) || "Evidence",
      href,
      controlId: displayId(controlId),
    };
  });

  const controls: ControlFact[] = [];
  for (const item of asArray(implementation["implemented-requirements"])) {
    const record = asRecord(item);
    const id = displayId(prose(record["control-id"]));
    if (!id) continue;
    const parts: string[] = [];
    for (const statement of asArray(record.statements)) {
      const text = prose(asRecord(statement).description);
      if (text) parts.push(text);
    }
    const roleIds: string[] = [];
    for (const role of asArray(record["responsible-roles"])) {
      const roleId = prose(asRecord(role)["role-id"]);
      if (roleId && !roleIds.includes(roleId)) roleIds.push(roleId);
    }
    const linked = new Set<string>();
    for (const link of asArray(record.links)) {
      const href = prose(asRecord(link).href);
      if (href.startsWith("#")) linked.add(href.slice(1));
    }
    const evidenceUuids: string[] = [];
    for (const resource of resources) {
      if (!resource.uuid) continue;
      const hit = linked.has(resource.uuid) || (resource.controlId !== "" && resource.controlId === id);
      if (!hit || evidenceUuids.includes(resource.uuid)) continue;
      evidenceUuids.push(resource.uuid);
    }
    const implementationText = parts.join("\n\n");
    const validEvidence = evidenceUuids.some((uuid) => {
      const resource = resources.find((item) => item.uuid === uuid);
      return Boolean(resource && resource.title.trim() && hrefOk(resource.href));
    });
    controls.push({
      id,
      family: familyOf(id),
      implementation: implementationText,
      roleIds,
      evidenceUuids,
      complete: Boolean(implementationText.trim() && roleIds.length > 0 && validEvidence),
    });
  }

  const familySet = new Set(controls.map((control) => control.family));
  const families = [
    ...catalog.familyOrder.filter((id) => familySet.has(id)),
    ...[...familySet].filter((id) => !catalog.familyOrder.includes(id)).sort((a, b) => a.localeCompare(b)),
  ];

  const evidence: EvidenceFact[] = [];
  const seen = new Set<string>();
  for (const resource of resources) {
    if (!resource.uuid || seen.has(resource.uuid)) continue;
    const controlIds = controls
      .filter((control) => control.evidenceUuids.includes(resource.uuid))
      .map((control) => control.id)
      .sort(compareControlId);
    if (controlIds.length === 0) continue;
    seen.add(resource.uuid);
    const evidenceFamilies = families.filter((family) => controlIds.some((id) => familyOf(id) === family));
    evidence.push({
      uuid: resource.uuid,
      id: resource.id.toUpperCase(),
      title: resource.title,
      href: resource.href,
      controlIds,
      families: evidenceFamilies,
      span: spanOf(evidenceFamilies, families),
    });
  }

  const incomplete = controls.filter((control) => !control.complete).length;
  const total = controls.length;
  const gateLabel = incomplete === 0
    ? `${total} of ${total} complete · gate open`
    : `${incomplete} of ${total} incomplete`;

  const systemIds = asArray(characteristics["system-ids"]);
  const boundaryId = prose(asRecord(systemIds[0]).id) || prose(characteristics["system-id"]);
  return {
    systemName: prose(characteristics["system-name"]) || prose(metadata.title),
    boundaryId,
    roles,
    controls,
    families,
    evidence,
    incomplete,
    gateLabel,
  };
}

type PlannedControl = {
  id: string;
  title: string;
  family: string;
  implementation: string;
  roleIds: string[];
};

type PlannedEvidence = {
  uuid: string;
  id: string;
  title: string;
  href: string;
  controlIds: string[];
};

function plannedDocument(
  seed: number,
  systemName: string,
  boundaryId: string,
  remarks: string,
  roles: Array<{ id: string; title: string; shortName: string }>,
  controls: PlannedControl[],
  evidence: PlannedEvidence[],
  rng: Rng,
): SspDocument {
  const componentUuid = uuidFrom(rng);
  return {
    "system-security-plan": {
      uuid: uuidFrom(rng),
      metadata: {
        title: systemName,
        "last-modified": "2026-09-25T16:00:00.000Z",
        version: "1.0.0",
        "oscal-version": "1.1.3",
        remarks,
        roles: roles.map((role) => ({
          id: role.id,
          title: role.title,
          "short-name": role.shortName,
        })),
      },
      "import-profile": { href: CATALOG_PIN },
      "system-characteristics": {
        "system-ids": [{ "identifier-type": "https://ietf.org/rfc/rfc4122", id: boundaryId }],
        "system-name": systemName,
        description: remarks,
        "security-sensitivity-level": "moderate",
        status: { state: "operational" },
        "authorization-boundary": { description: `Authorization boundary ${boundaryId}.` },
      },
      "system-implementation": {
        users: roles.map((role) => ({
          uuid: uuidFrom(rng),
          title: role.title,
          "role-ids": [role.id],
        })),
        components: [{
          uuid: componentUuid,
          type: "system",
          title: systemName,
          description: systemName,
          status: { state: "operational" },
        }],
      },
      "control-implementation": {
        description: remarks,
        "implemented-requirements": controls.map((control) => {
          const links = evidence
            .filter((item) => item.controlIds.includes(control.id))
            .map((item) => ({ href: `#${item.uuid}`, rel: "evidence" }));
          const requirement: Record<string, unknown> = {
            uuid: uuidFrom(rng),
            "control-id": control.id,
            "responsible-roles": control.roleIds.map((roleId) => ({ "role-id": roleId })),
          };
          if (control.implementation) {
            requirement.statements = [{
              "statement-id": `${control.id}_smt`,
              uuid: uuidFrom(rng),
              description: control.implementation,
            }];
          }
          if (links.length > 0) requirement.links = links;
          return requirement;
        }),
      },
      "back-matter": {
        resources: evidence.map((item) => ({
          uuid: item.uuid,
          title: item.title,
          props: [
            { name: "type", value: "Document" },
            { name: "evidence-id", value: item.id },
          ],
          rlinks: [{ href: item.href }],
        })),
      },
    },
  };
}

/**
 * Build a valid Rev5 SSP. Family count is 1–6, controls per family 1–5,
 * roles 1–7. Evidence may be absent. Every metadata role is assigned at
 * least once so a chip can exist for each role in the file.
 */
export function generatePackage(seed: number): { seed: number; document: SspDocument } {
  const rng = mulberry32(seed);
  const catalog = catalogIndex();
  const familyCount = int(rng, 1, 6);
  const picked = shuffle(rng, catalog.familyOrder.filter((id) => (catalog.byFamily.get(id)?.length ?? 0) > 0))
    .slice(0, familyCount)
    .sort((a, b) => catalog.familyOrder.indexOf(a) - catalog.familyOrder.indexOf(b));

  const controls: PlannedControl[] = [];
  for (const family of picked) {
    const available = catalog.byFamily.get(family) ?? [];
    const count = int(rng, 1, Math.min(5, available.length));
    for (const control of shuffle(rng, available).slice(0, count)) {
      controls.push({
        id: control.id,
        title: control.title,
        family,
        implementation: "",
        roleIds: [],
      });
    }
  }
  controls.sort((a, b) => compareControlId(displayId(a.id), displayId(b.id)));

  const roleCount = int(rng, 1, ROLE_POOL.length);
  const roles = shuffle(rng, ROLE_POOL).slice(0, roleCount);
  const buckets = controls.map(() => [] as string[]);
  roles.forEach((role, index) => {
    buckets[index % controls.length]!.push(role.id);
  });
  controls.forEach((control, index) => {
    if (controls.length > 1 && rng() < 0.35 && buckets[index]!.length < 3) {
      const extra = roles[int(rng, 0, roles.length - 1)]!;
      if (!buckets[index]!.includes(extra.id)) buckets[index]!.push(extra.id);
    }
    control.roleIds = buckets[index]!;
    control.implementation = `${control.title} is performed for generated package ${seed}.`;
  });
  if (controls.length > 1) controls[controls.length - 1]!.implementation = "";

  const evidence: PlannedEvidence[] = [];
  const zeroEvidence = rng() < 0.2;
  if (!zeroEvidence && controls.length > 0) {
    let sequence = 1;
    const add = (title: string, controlIds: string[]) => {
      const ids = [...new Set(controlIds)];
      if (ids.length === 0) return;
      evidence.push({
        uuid: uuidFrom(rng),
        id: `EV-G${String(sequence).padStart(2, "0")}`,
        title,
        href: `https://evidence.example/generated/${seed}/${sequence}`,
        controlIds: ids,
      });
      sequence += 1;
    };
    const byFamily = new Map<string, PlannedControl[]>();
    for (const control of controls) {
      const list = byFamily.get(control.family) ?? [];
      list.push(control);
      byFamily.set(control.family, list);
    }
    const at = (family: string, index: number) => byFamily.get(family)?.[index];
    const first = picked[0]!;
    const single = at(first, 0);
    if (single) add(`Single family ${first} record`, [single.id]);
    if (picked.length >= 2) {
      const leftFamily = picked[0]!;
      const rightFamily = picked[1]!;
      const left = at(leftFamily, (byFamily.get(leftFamily)?.length ?? 1) > 1 ? 1 : 0);
      const right = at(rightFamily, 0);
      if (left && right) add("Adjacent family record", [left.id, right.id]);
    }
    if (picked.length >= 3) {
      const left = at(picked[0]!, 0);
      const right = at(picked[picked.length - 1]!, 0);
      if (left && right && left.id !== right.id) add("Non-adjacent family record", [left.id, right.id]);
    }
    if (controls.length > 1) {
      const holdout = controls[controls.length - 1]!.id;
      for (const item of evidence) item.controlIds = item.controlIds.filter((id) => id !== holdout);
      for (let index = evidence.length - 1; index >= 0; index -= 1) {
        if (evidence[index]!.controlIds.length === 0) evidence.splice(index, 1);
      }
    }
  }

  const systemName = `Generated package ${seed}`;
  const boundaryId = `bnd-gen-${seed}`;
  const remarks = `Generated OSCAL Rev5 SSP for seed ${seed}. Not the 12-control sample package.`;
  return {
    seed,
    document: plannedDocument(seed, systemName, boundaryId, remarks, roles, controls, evidence, rng),
  };
}

export function packageText(document: unknown): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

export function annotateSeed(seed: number | string, error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  const wrapped = new Error(`seed ${seed}\n${message}`);
  wrapped.cause = error;
  return wrapped;
}

export function randomSeed(): number {
  const fromEnv = Number(process.env.UPLOAD_PACKAGE_SEED);
  if (Number.isInteger(fromEnv) && fromEnv > 0) return fromEnv;
  return 1 + Math.floor(Math.random() * 1_000_000_000);
}

const RUN_SEED_FILE = path.join(os.tmpdir(), "aegis-upload-package-seed.txt");

/**
 * One seed per Playwright run. The test loader and the worker import this
 * module separately, so a bare Math.random() would change the test title.
 * The loader writes the file. Workers read it. `UPLOAD_PACKAGE_SEED` wins.
 */
export function stableRunSeed(): number {
  const fromEnv = Number(process.env.UPLOAD_PACKAGE_SEED);
  if (Number.isInteger(fromEnv) && fromEnv > 0) return fromEnv;
  if (process.env.TEST_WORKER_INDEX === undefined) {
    const seed = randomSeed();
    writeFileSync(RUN_SEED_FILE, `${seed}\n`);
    return seed;
  }
  const saved = Number(readFileSync(RUN_SEED_FILE, "utf8").trim());
  if (!Number.isInteger(saved) || saved <= 0) throw new Error(`bad upload package seed file ${RUN_SEED_FILE}`);
  return saved;
}
