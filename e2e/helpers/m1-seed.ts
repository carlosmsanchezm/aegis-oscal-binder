import { expect, type APIRequestContext } from "@playwright/test";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { toStored } from "../../lib/m1/api";
import type { StoredFile } from "../../lib/digest-model";
import type { PackageState } from "../../lib/aegis/types";
import after from "../../lib/reference/online-boutique-after.json" with { type: "json" };

/** The captured Online Boutique event. Its SHA 256 is the locked receipt id 7c78c4bb...b97406a. */
export const BOUTIQUE_BYTES = Buffer.from(after.rawEvent, "utf8");
export const BOUTIQUE_DIGEST = createHash("sha256").update(BOUTIQUE_BYTES).digest("hex");
export const BUNDLE_TITLE = "Retained evidence bundle";
export const BUNDLE_FILE = "boutique-after-fix.json";

export type Seeded = {
  objects: Array<{ objectKey: string; objectName: string; kind: "evidence" | "export"; role: string; exportId: string | null; recordedDigest: string | null; current: boolean }>;
};

export type SeedOptions = { evidence?: boolean; exports?: number; renders?: boolean; planning?: boolean; complete?: boolean };

/** Fresh session, Gold fixture, the boutique event stored on AC-6 and exports, all through the real routes. */
export async function seedStore(request: APIRequestContext, options: SeedOptions = {}): Promise<Seeded> {
  const { evidence = true, exports = 1, renders = false, planning = false, complete = false } = options;
  const route = (url: string) => planning ? url.replace("/api/", "/api/demo/sa1/") : url;
  expect((await request.post(route("/api/workspace/reset"))).ok()).toBeTruthy();
  expect((await request.post(route("/api/catalogs/select"), { data: { catalog: "fedramp-rev5" } })).ok()).toBeTruthy();
  expect((await request.post(route("/api/fixtures/load"), { data: { fixture: "gold" } })).ok()).toBeTruthy();
  if (evidence) {
    const uploaded = await request.post(route("/api/controls/AC-6/evidence/file"), {
      multipart: { title: BUNDLE_TITLE, type: "Document", file: { name: BUNDLE_FILE, mimeType: "application/json", buffer: BOUTIQUE_BYTES } },
    });
    expect(uploaded.ok(), await uploaded.text()).toBeTruthy();
  }
  if (complete) {
    const current = await request.get(route("/api/package"));
    const pkg = (await current.json()).packageState as PackageState;
    for (const control of pkg.controls.filter(item => !item.complete)) {
      const saved = await request.post(route(`/api/controls/${control.id}/save`), { data: {
        implementation: control.implementation || "Synthetic implementation for the locked UI acceptance fixture.",
        responsibleRole: control.responsibleRoleId || pkg.roles[0]!.id,
        ...(control.validEvidenceCount ? {} : { evidence: { title: "Synthetic acceptance evidence", type: "Document", href: `https://example.com/evidence/${control.id}` } }),
      } });
      expect(saved.ok(), await saved.text()).toBeTruthy();
    }
  }
  for (let index = 0; index < exports; index += 1) {
    const exported = await request.post(route("/api/oscal/export"));
    expect(exported.ok(), await exported.text()).toBeTruthy();
    if (renders) {
      const validated = await request.post(route("/api/oscal/validate"), { data: { scenario: "current" } });
      expect(validated.ok(), await validated.text()).toBeTruthy();
      for (const kind of ["word", "excel"]) {
        const rendered = await request.post(route(`/api/render/${kind}`));
        expect(rendered.ok(), await rendered.text()).toBeTruthy();
      }
    }
  }
  return inventory(request, planning);
}

export async function inventory(request: APIRequestContext, planning = false): Promise<Seeded> {
  const response = await request.get(planning ? "/api/demo/sa1/digest/files" : "/api/digest/files");
  expect(response.ok(), await response.text()).toBeTruthy();
  const body = await response.json();
  return { objects: (body.files as StoredFile[]).map(toStored) };
}

function findAll(dir: string, name: string, found: string[] = []): string[] {
  if (!existsSync(dir)) return found;
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) findAll(full, name, found);
    else if (entry === name) found.push(full);
  }
  return found;
}

export type StoredRef = { objectName: string; recordedDigest: string | null };

/** The directory store the web server writes to (AEGIS_DATA_DIR of the Playwright web server). */
export function dataDir(): string {
  const dir = process.env.AEGIS_E2E_DATA_DIR;
  if (!dir) throw new Error("AEGIS_E2E_DATA_DIR is not set");
  return dir;
}

/** Export file names repeat across sessions, so the file is the newest one holding the recorded bytes. */
export function storedPath(object: StoredRef): string {
  const sha = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
  const found = findAll(dataDir(), object.objectName)
    .filter((file) => !object.recordedDigest || sha(file) === object.recordedDigest)
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  if (!found[0]) throw new Error(`Stored file ${object.objectName} was not found under the data directory`);
  return found[0];
}

/** Change one stored byte on disk and return the bytes now on disk. */
export function tamperOneByte(object: StoredRef, offset = 2): { file: string; before: Buffer; after: Buffer } {
  const file = storedPath(object);
  const before = readFileSync(file);
  const next = Buffer.from(before);
  next[offset] = next[offset] === 0x41 ? 0x42 : 0x41;
  writeFileSync(file, next);
  return { file, before, after: next };
}

/** Retain exact captured public bytes through the owner checked browser import route. */
export async function seedRetained(request: APIRequestContext) {
  const created = await request.post("/api/builder", { data: { name: "Online Boutique" } });
  expect(created.ok(), await created.text()).toBeTruthy();
  const connection = (await created.json()).connection.id as string;
  const imported = await request.post(`/api/builder/connections/${connection}/imports`, { data: BOUTIQUE_BYTES, headers: { "content-type": "application/json" } });
  expect(imported.ok(), await imported.text()).toBeTruthy();
  const evidenceId = (await imported.json()).evidenceId as string;
  return { connection, evidenceId, url: `/evidence/${evidenceId}?connection=${connection}` };
}
