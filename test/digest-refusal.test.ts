import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { GET as getEvidenceBytes } from "../app/api/controls/[controlId]/evidence/[evidenceId]/bytes/route";
import { POST as regenerateRoute } from "../app/api/digest/regenerate/route";
import { GET as listRefusalsRoute } from "../app/api/digest/refusals/route";
import { GET as refusalTrailRoute } from "../app/api/digest/refusals/[objectKey]/route";
import { GET as getVerifyRoute, POST as postVerifyRoute } from "../app/api/digest/verify/route";
import { GET as getOscal } from "../app/api/artifacts/oscal/route";
import { POST as selectCatalog } from "../app/api/catalogs/select/route";
import { AegisError, addEvidenceFile, emptyPersisted, exportOscal, findRepoRoot, loadFixture } from "../lib/aegis";
import { sha256Bytes } from "../lib/aegis/hash";
import { outDir, Session } from "../lib/aegis/store";
import { DIGEST_CHECK_NOTE, digestMismatchMessage, digestObjectKey, listDigestAudits, readDigestCheck } from "../lib/digest-audit";
import { regenerateStoredExport, verifyStoredDigests } from "../lib/digest-recovery";
import { setBlobIoForTests, type BlobIo } from "../lib/durable";
import { flushRetainedWrites, locateWorkspaceEvidence, readRetained, resetRetainedForTests } from "../lib/retained-bytes";

const root = findRepoRoot();
const payload = "retention sample bytes";

type RefusalBody = {
  ok: boolean;
  error?: { code: string; message: string; details: Record<string, unknown> | null };
  refusals?: Array<{ objectKey: string; kind: string; entries: Array<Record<string, unknown>> }>;
  entries?: Array<Record<string, unknown>>;
  objectKey?: string;
  objectName?: string;
  kind?: string;
  recordedDigest?: string;
  recomputedDigest?: string;
  truncated?: boolean;
  matched?: number | null;
  mismatched?: number | null;
  skipped?: number | null;
  checkedAt?: string | null;
  note?: string;
  regenerated?: Record<string, unknown>;
};

function restore(name: "AEGIS_DATA_DIR" | "BLOB_READ_WRITE_TOKEN" | "VERCEL" | "VERCEL_ENV" | "BLOB_STORE_ID", value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function assertNoHyphen(copy: string): void {
  assert.equal(copy.includes("-"), false, copy);
}

function cookieHeader(id: string): Headers {
  return new Headers({ cookie: `aegis_sid=${id}` });
}

function countFiles(dir: string): number {
  if (!existsSync(dir)) return 0;
  let count = 0;
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    count += statSync(full).isDirectory() ? countFiles(full) : 1;
  }
  return count;
}

async function readJson(response: Response): Promise<RefusalBody> {
  const text = await response.text();
  return JSON.parse(text) as RefusalBody;
}

function freshChildEntries(dir: string): Array<Record<string, unknown>> {
  const child = spawnSync(process.execPath, ["-e", `
    const fs = require("node:fs");
    const path = require("node:path");
    const dir = process.env.AUDIT_DIR;
    const rows = [];
    function walk(current) {
      if (!fs.existsSync(current)) return;
      for (const name of fs.readdirSync(current)) {
        const full = path.join(current, name);
        if (fs.statSync(full).isDirectory()) walk(full);
        else if (name.endsWith(".json")) rows.push(JSON.parse(fs.readFileSync(full, "utf8")));
      }
    }
    walk(dir);
    process.stdout.write(JSON.stringify(rows));
  `], {
    env: { ...process.env, AUDIT_DIR: dir },
    encoding: "utf8",
  });
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout) as Array<Record<string, unknown>>;
}

describe("digest refusal audit and recovery", { concurrency: false }, () => {
  test("copy does not claim a cause", () => {
    assertNoHyphen(digestMismatchMessage("evidence"));
    assertNoHyphen(digestMismatchMessage("export"));
    assertNoHyphen(DIGEST_CHECK_NOTE);
    assert.match(DIGEST_CHECK_NOTE, /not approval/);
    assert.doesNotMatch(digestMismatchMessage("evidence"), /tamper|corrupt|attack|because/i);
    assert.doesNotMatch(DIGEST_CHECK_NOTE, /tamper|corrupt|attack|because/i);
  });

  test("a tampered export is refused, kept, audited, and regenerated beside the old bytes", async () => {
    const previousData = process.env.AEGIS_DATA_DIR;
    const previousToken = process.env.BLOB_READ_WRITE_TOKEN;
    const previousVercel = process.env.VERCEL;
    const dir = mkdtempSync(path.join(os.tmpdir(), "aegisRefusal"));
    try {
      process.env.AEGIS_DATA_DIR = dir;
      delete process.env.BLOB_READ_WRITE_TOKEN;
      delete process.env.VERCEL;
      const id = "cd".repeat(16);
      const fixedNow = new Date("2020-01-01T00:00:00.000Z");
      const session = Session.create(id, root);
      const ctx = { ...session.ctx, outDir: outDir(root, id), now: () => fixedNow };
      const loaded = loadFixture(emptyPersisted(), "gold", ctx);
      const withFile = addEvidenceFile(loaded, "AU-2", {
        filename: "retention-note.txt",
        bytes: Buffer.from(payload),
        title: "Retention note",
        type: "Document",
      }, ctx);
      const exported = exportOscal(withFile, ctx);
      await flushRetainedWrites();
      session.commit(exported.state);
      await session.flush();
      const evidence = exported.state.controls.find((control) => control.id === "AU-2")?.evidence.find((item) => item.title === "Retention note");
      assert.ok(evidence?.sha256);
      const evidencePath = locateWorkspaceEvidence(root, evidence.href, id);
      assert.ok(evidencePath);
      assert.equal(existsSync(evidencePath), true);
      assert.equal(existsSync(exported.filePath), true);
      const absent = await getVerifyRoute(new Request("http://127.0.0.1/api/digest/verify", { headers: cookieHeader(id) }));
      const absentBody = await readJson(absent);
      assert.equal(absent.status, 200);
      assert.equal(absentBody.matched, null);
      assert.equal(absentBody.mismatched, null);
      assert.equal(absentBody.skipped, null);
      assert.equal(absentBody.checkedAt, null);
      assert.equal(absentBody.note, DIGEST_CHECK_NOTE);
      const originalExport = readFileSync(exported.filePath);
      const beforeNames = readdirSync(path.dirname(exported.filePath));

      const cleanRegen = await regenerateRoute(new Request("http://127.0.0.1/api/digest/regenerate", {
        method: "POST",
        headers: new Headers({ cookie: `aegis_sid=${id}`, "content-type": "application/json" }),
        body: JSON.stringify({ exportId: exported.exportId }),
      }));
      const cleanBody = await readJson(cleanRegen);
      assert.equal(cleanRegen.status, 409);
      assert.equal(cleanBody.error?.code, "REGENERATE_UNNEEDED");
      assertNoHyphen(cleanBody.error?.message ?? "");
      assert.deepEqual(readdirSync(path.dirname(exported.filePath)), beforeNames);
      assert.equal(readFileSync(exported.filePath).equals(originalExport), true);

      const tampered = Buffer.from(originalExport);
      tampered[0] = tampered[0] === 0x3c ? 0x20 : 0x3c;
      writeFileSync(exported.filePath, tampered);
      const refused = await getOscal(new Request("http://127.0.0.1/api/artifacts/oscal", { headers: cookieHeader(id) }));
      const refusedText = await refused.text();
      const refusedBody = JSON.parse(refusedText) as RefusalBody;
      assert.equal(refused.status, 409);
      assert.equal(refused.headers.get("content-type")?.includes("application/json"), true);
      assert.equal(refusedText.includes("<system-security-plan"), false);
      assert.equal(refusedText.includes(payload), false);
      assert.equal(refusedBody.ok, false);
      assert.equal(refusedBody.error?.code, "DIGEST_MISMATCH");
      assertNoHyphen(refusedBody.error?.message ?? "");
      assert.doesNotMatch(refusedBody.error?.message ?? "", /tamper|corrupt|attack|because/i);
      const details = refusedBody.error?.details ?? {};
      assert.equal(details.objectName, path.basename(exported.filePath));
      assert.equal(details.objectKey, digestObjectKey(exported.filePath));
      assert.equal(details.recordedDigest, exported.state.exports.at(-1)?.sha256);
      assert.equal(details.recomputedDigest, sha256Bytes(tampered));
      assert.equal(details.kind, "export");
      assert.equal(typeof details.refusedAt, "string");
      assert.ok(Math.abs(Date.parse(String(details.refusedAt)) - Date.now()) < 60_000);
      assert.notEqual(details.refusedAt, fixedNow.toISOString());
      assert.match(String(details.id), /^[a-f0-9]{32}$/);
      assert.equal(readFileSync(exported.filePath).equals(tampered), true);

      const auditDir = path.join(dir, "digest-refusals", id);
      const firstAudit = freshChildEntries(auditDir);
      assert.equal(firstAudit.length, 1);
      const firstFile = readdirSync(path.join(auditDir, String(details.objectKey)))[0];
      assert.ok(firstFile);
      const firstBytes = readFileSync(path.join(auditDir, String(details.objectKey), firstFile));
      const again = await getOscal(new Request("http://127.0.0.1/api/artifacts/oscal", { headers: cookieHeader(id) }));
      assert.equal(again.status, 409);
      assert.equal(readFileSync(path.join(auditDir, String(details.objectKey), firstFile)).equals(firstBytes), true);
      assert.ok(readdirSync(path.join(auditDir, String(details.objectKey))).length >= 2);

      const list = await listRefusalsRoute(new Request("http://127.0.0.1/api/digest/refusals", { headers: cookieHeader(id) }));
      const listed = await readJson(list);
      assert.equal(list.status, 200);
      assert.equal(listed.ok, true);
      const group = listed.refusals?.find((item) => item.objectKey === details.objectKey);
      assert.ok(group);
      assert.equal(group.kind, "export");
      assert.ok(group.entries.length >= 2);
      const trail = await refusalTrailRoute(new Request(`http://127.0.0.1/api/digest/refusals/${details.objectKey}`, { headers: cookieHeader(id) }), {
        params: Promise.resolve({ objectKey: String(details.objectKey) }),
      });
      const trailBody = await readJson(trail);
      assert.equal(trail.status, 200);
      assert.equal(trailBody.objectKey, details.objectKey);
      assert.equal(trailBody.kind, "export");
      assert.equal(trailBody.recordedDigest, details.recordedDigest);
      assert.equal(trailBody.entries?.length, group.entries.length);

      const other = await selectCatalog(new Request("http://127.0.0.1/api/catalogs/select", {
        method: "POST",
        headers: new Headers({ "content-type": "application/json" }),
        body: JSON.stringify({ catalog: "fedramp-rev5" }),
      }));
      const otherCookie = other.headers.getSetCookie().map((cookie) => /^aegis_sid=([a-f0-9]{32})/.exec(cookie)?.[1]).find(Boolean);
      assert.ok(otherCookie);
      const otherList = await listRefusalsRoute(new Request("http://127.0.0.1/api/digest/refusals", { headers: cookieHeader(otherCookie) }));
      const otherBody = await readJson(otherList);
      assert.equal(otherList.status, 200);
      assert.deepEqual(otherBody.refusals, []);

      const regenerated = await regenerateRoute(new Request("http://127.0.0.1/api/digest/regenerate", {
        method: "POST",
        headers: new Headers({ cookie: `aegis_sid=${id}`, "content-type": "application/json" }),
        body: JSON.stringify({ exportId: exported.exportId }),
      }));
      const regeneratedBody = await readJson(regenerated);
      assert.equal(regenerated.status, 200, JSON.stringify(regeneratedBody));
      assert.equal(regeneratedBody.regenerated?.kind, "export");
      assert.equal(regeneratedBody.regenerated?.render, "oscal");
      assert.equal(regeneratedBody.regenerated?.exportId, exported.exportId);
      assert.equal(regeneratedBody.regenerated?.source, "export record");
      assert.equal(regeneratedBody.regenerated?.keptPriorBytes, true);
      assert.equal(regeneratedBody.regenerated?.priorObjectName, path.basename(exported.filePath));
      assert.equal(regeneratedBody.regenerated?.priorRecordedDigest, details.recordedDigest);
      assert.equal(regeneratedBody.regenerated?.priorRecomputedDigest, sha256Bytes(tampered));
      assert.equal(readFileSync(exported.filePath).equals(tampered), true);
      const snapshot = JSON.parse(readFileSync(path.join(dir, "sessions", id, "state.json"), "utf8")) as { state: { exports: Array<{ filePath: string; sha256?: string; filename: string; priorObjects?: Array<{ filePath: string }> }> } };
      const record = snapshot.state.exports.at(-1);
      assert.ok(record);
      assert.notEqual(record.filePath, exported.filePath);
      assert.equal(record.filename, path.basename(exported.filePath));
      assert.equal(record.priorObjects?.[0]?.filePath, exported.filePath);
      assert.equal(existsSync(record.filePath), true);
      assert.equal(sha256Bytes(readFileSync(record.filePath)), record.sha256);
      assert.equal(readFileSync(record.filePath).toString("utf8"), exported.xml);

      const downloaded = await getOscal(new Request("http://127.0.0.1/api/artifacts/oscal", { headers: cookieHeader(id) }));
      assert.equal(downloaded.status, 200);
      assert.equal(await downloaded.text(), exported.xml);
      const evidenceResponse = await getEvidenceBytes(new Request(`http://127.0.0.1/api/controls/AU-2/evidence/${evidence.id}/bytes`, { headers: cookieHeader(id) }), {
        params: Promise.resolve({ controlId: "AU-2", evidenceId: evidence.id }),
      });
      assert.equal(evidenceResponse.status, 200);
      assert.equal(Buffer.from(await evidenceResponse.arrayBuffer()).toString("utf8"), payload);
      assert.equal(readFileSync(evidencePath).toString("utf8"), payload);

      const verified = await postVerifyRoute(new Request("http://127.0.0.1/api/digest/verify", { method: "POST", headers: cookieHeader(id) }));
      const verifiedBody = await readJson(verified);
      assert.equal(verified.status, 200, JSON.stringify(verifiedBody));
      assert.equal(verifiedBody.matched, 2);
      assert.equal(verifiedBody.mismatched, 1);
      assert.equal(verifiedBody.skipped, 0);
      assert.equal(typeof verifiedBody.checkedAt, "string");
      assert.ok(Math.abs(Date.parse(verifiedBody.checkedAt ?? "") - Date.now()) < 60_000);
      assert.notEqual(verifiedBody.checkedAt, fixedNow.toISOString());
      assert.equal(verifiedBody.note, DIGEST_CHECK_NOTE);
      assertNoHyphen(verifiedBody.note ?? "");
      const storedCheck = await getVerifyRoute(new Request("http://127.0.0.1/api/digest/verify", { headers: cookieHeader(id) }));
      const storedBody = await readJson(storedCheck);
      assert.equal(storedCheck.status, 200);
      assert.equal(storedBody.checkedAt, verifiedBody.checkedAt);
      assert.equal(storedBody.matched, 2);
      assert.equal(storedBody.mismatched, 1);
      assert.equal(storedBody.note, DIGEST_CHECK_NOTE);
      const checkFile = path.join(dir, "digest-checks", `${id}.json`);
      const checkFromDisk = JSON.parse(readFileSync(checkFile, "utf8")) as { checkedAt: string; matched: number; mismatched: number };
      assert.equal(checkFromDisk.checkedAt, verifiedBody.checkedAt);
      assert.equal(checkFromDisk.matched, 2);
      assert.equal(checkFromDisk.mismatched, 1);
      const survived = freshChildEntries(auditDir);
      assert.ok(survived.some((entry) => entry.objectKey === details.objectKey && entry.recordedDigest === details.recordedDigest && entry.kind === "export"));
      assert.equal(readFileSync(exported.filePath).equals(tampered), true);
    } finally {
      restore("AEGIS_DATA_DIR", previousData);
      restore("BLOB_READ_WRITE_TOKEN", previousToken);
      restore("VERCEL", previousVercel);
      resetRetainedForTests();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a tampered evidence file is refused and an untouched export still reads", async () => {
    const previousData = process.env.AEGIS_DATA_DIR;
    const previousToken = process.env.BLOB_READ_WRITE_TOKEN;
    const previousVercel = process.env.VERCEL;
    const dir = mkdtempSync(path.join(os.tmpdir(), "aegisEvidence"));
    try {
      process.env.AEGIS_DATA_DIR = dir;
      delete process.env.BLOB_READ_WRITE_TOKEN;
      delete process.env.VERCEL;
      const id = "ab".repeat(16);
      const session = Session.create(id, root);
      const ctx = { ...session.ctx, outDir: outDir(root, id), now: () => new Date("2020-01-01T00:00:00.000Z") };
      const loaded = loadFixture(emptyPersisted(), "gold", ctx);
      const withFile = addEvidenceFile(loaded, "AU-2", {
        filename: "retention-note.txt",
        bytes: Buffer.from(payload),
        title: "Retention note",
        type: "Document",
      }, ctx);
      const exported = exportOscal(withFile, ctx);
      session.commit(exported.state);
      await session.flush();
      const evidence = exported.state.controls.find((control) => control.id === "AU-2")?.evidence.find((item) => item.title === "Retention note");
      assert.ok(evidence);
      const evidencePath = locateWorkspaceEvidence(root, evidence.href, id);
      assert.ok(evidencePath);
      const original = readFileSync(evidencePath);
      const tampered = Buffer.from(original);
      tampered[0] = tampered[0] === 0x72 ? 0x73 : 0x72;
      writeFileSync(evidencePath, tampered);
      const refused = await getEvidenceBytes(new Request(`http://127.0.0.1/api/controls/AU-2/evidence/${evidence.id}/bytes`, { headers: cookieHeader(id) }), {
        params: Promise.resolve({ controlId: "AU-2", evidenceId: evidence.id }),
      });
      const body = await readJson(refused);
      assert.equal(refused.status, 409);
      assert.equal(body.error?.code, "DIGEST_MISMATCH");
      assert.equal(body.error?.details?.kind, "evidence");
      assert.equal(body.error?.details?.objectName, path.basename(evidencePath));
      assert.equal(body.error?.details?.recordedDigest, evidence.sha256);
      assert.equal(body.error?.details?.recomputedDigest, sha256Bytes(tampered));
      assertNoHyphen(body.error?.message ?? "");
      assert.equal(JSON.stringify(body).includes(payload), false);
      assert.equal(readFileSync(evidencePath).equals(tampered), true);
      const exportedResponse = await getOscal(new Request("http://127.0.0.1/api/artifacts/oscal", { headers: cookieHeader(id) }));
      assert.equal(exportedResponse.status, 200);
      assert.equal(await exportedResponse.text(), exported.xml);
      const survived = freshChildEntries(path.join(dir, "digest-refusals", id));
      assert.ok(survived.some((entry) => entry.kind === "evidence" && entry.recordedDigest === evidence.sha256));
    } finally {
      restore("AEGIS_DATA_DIR", previousData);
      restore("BLOB_READ_WRITE_TOKEN", previousToken);
      restore("VERCEL", previousVercel);
      resetRetainedForTests();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("blob audit and the last check survive a cleared process cache", async () => {
    const previousData = process.env.AEGIS_DATA_DIR;
    const previousToken = process.env.BLOB_READ_WRITE_TOKEN;
    const previousVercel = process.env.VERCEL;
    const bytes = new Map<string, Buffer>();
    const texts = new Map<string, string>();
    const writes: string[] = [];
    const io: BlobIo = {
      async put(pathname, body, allowOverwrite) {
        if (!allowOverwrite && texts.has(pathname)) throw new Error("exists");
        texts.set(pathname, body);
      },
      async get(pathname) {
        return texts.get(pathname) ?? null;
      },
      async list(prefix) {
        return [...new Set([...texts.keys(), ...bytes.keys()])].filter((key) => key.startsWith(prefix));
      },
      async putBytes(pathname, body, allowOverwrite) {
        writes.push(pathname);
        if (!allowOverwrite && bytes.has(pathname)) throw new Error("exists");
        bytes.set(pathname, Buffer.from(body));
      },
      async getBytes(pathname) {
        const found = bytes.get(pathname);
        return found ? Buffer.from(found) : null;
      },
    };
    const id = "ef".repeat(16);
    try {
      setBlobIoForTests(io);
      delete process.env.AEGIS_DATA_DIR;
      delete process.env.BLOB_READ_WRITE_TOKEN;
      delete process.env.VERCEL;
      const ctx = { root, ownerKey: id, outDir: path.join(os.tmpdir(), "aegisUnusedBlob"), now: () => new Date("2020-01-01T00:00:00.000Z") };
      const loaded = loadFixture(emptyPersisted(), "gold", ctx);
      const withFile = addEvidenceFile(loaded, "AU-2", {
        filename: "retention-note.txt",
        bytes: Buffer.from(payload),
        title: "Retention note",
        type: "Document",
      }, ctx);
      const exported = exportOscal(withFile, ctx);
      await flushRetainedWrites();
      const evidence = exported.state.controls.find((control) => control.id === "AU-2")?.evidence.find((item) => item.title === "Retention note");
      assert.ok(evidence?.sha256);
      const evidenceKey = locateWorkspaceEvidence(root, evidence.href, id);
      assert.ok(evidenceKey);
      const exportBytes = Buffer.from(bytes.get(exported.filePath)!);
      const tampered = Buffer.from(exportBytes);
      tampered[0] = tampered[0] === 0x3c ? 0x20 : 0x3c;
      bytes.set(exported.filePath, tampered);
      const writesBefore = writes.length;
      await assert.rejects(readRetained(exported.filePath, exported.state.exports.at(-1)?.sha256, "Export", { ownerKey: id }), (error: unknown) => {
        return error instanceof AegisError && error.code === "DIGEST_MISMATCH" && (error.details as { kind?: string }).kind === "export";
      });
      assert.equal(bytes.get(exported.filePath)?.equals(tampered), true);
      resetRetainedForTests();
      const persisted = await listDigestAudits(id);
      assert.ok(persisted.entries.some((entry) => entry.kind === "export" && entry.recomputedDigest === sha256Bytes(tampered)));
      const regenerated = await regenerateStoredExport(exported.state, ctx, { exportId: exported.exportId });
      await flushRetainedWrites();
      const nextPath = regenerated.state.exports.at(-1)?.filePath ?? "";
      assert.equal(bytes.get(exported.filePath)?.equals(tampered), true);
      assert.equal(writes.slice(writesBefore).includes(exported.filePath), false);
      assert.notEqual(nextPath, exported.filePath);
      assert.equal(bytes.get(nextPath)?.equals(Buffer.from(exported.xml)), true);
      const evidenceBytes = await readRetained(evidenceKey, evidence.sha256, "Evidence file", { ownerKey: id });
      assert.equal(evidenceBytes?.toString("utf8"), payload);
      const check = await verifyStoredDigests(regenerated.state, ctx);
      assert.equal(check.matched, 2);
      assert.equal(check.mismatched, 1);
      assert.notEqual(check.checkedAt, "2020-01-01T00:00:00.000Z");
      assert.ok(Math.abs(Date.parse(check.checkedAt) - Date.now()) < 60_000);
      resetRetainedForTests();
      const again = await readDigestCheck(id);
      assert.equal(again?.checkedAt, check.checkedAt);
      const audits = await listDigestAudits(id);
      assert.ok(audits.entries.length >= 1);
    } finally {
      setBlobIoForTests(null);
      resetRetainedForTests();
      restore("AEGIS_DATA_DIR", previousData);
      restore("BLOB_READ_WRITE_TOKEN", previousToken);
      restore("VERCEL", previousVercel);
    }
  });

  test("vercel without durable storage fails closed and does not write an audit directory", async () => {
    const previous = {
      data: process.env.AEGIS_DATA_DIR,
      token: process.env.BLOB_READ_WRITE_TOKEN,
      vercel: process.env.VERCEL,
      env: process.env.VERCEL_ENV,
    };
    const refusalDir = path.join(root, ".data", "digest-refusals");
    const before = countFiles(refusalDir);
    const file = path.join(os.tmpdir(), `aegisClosedRead${Date.now()}`);
    try {
      setBlobIoForTests(null);
      delete process.env.AEGIS_DATA_DIR;
      delete process.env.BLOB_READ_WRITE_TOKEN;
      delete process.env.VERCEL_ENV;
      process.env.VERCEL = "1";
      writeFileSync(file, Buffer.from("abcdef"));
      await assert.rejects(verifyStoredDigests(emptyPersisted(), { root, ownerKey: "12".repeat(16) }), (error: unknown) => {
        return error instanceof AegisError && error.code === "STORE_UNAVAILABLE";
      });
      const route = await postVerifyRoute(new Request("http://127.0.0.1/api/digest/verify", {
        method: "POST",
        headers: cookieHeader("34".repeat(16)),
      }));
      const body = await readJson(route);
      assert.equal(route.status, 503);
      assert.equal(body.error?.code, "STORE_UNAVAILABLE");
      assert.equal(body.matched, undefined);
      await assert.rejects(readRetained(file, sha256Bytes("zzzzzz"), "Evidence file"), (error: unknown) => {
        return error instanceof AegisError && error.code === "DIGEST_MISMATCH";
      });
      assert.equal(readFileSync(file).toString("utf8"), "abcdef");
      assert.equal(countFiles(refusalDir), before);
    } finally {
      setBlobIoForTests(null);
      resetRetainedForTests();
      unlinkSync(file);
      restore("AEGIS_DATA_DIR", previous.data);
      restore("BLOB_READ_WRITE_TOKEN", previous.token);
      restore("VERCEL", previous.vercel);
      if (previous.env === undefined) delete process.env.VERCEL_ENV;
      else process.env.VERCEL_ENV = previous.env;
    }
  });
});
