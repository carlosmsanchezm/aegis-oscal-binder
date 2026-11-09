import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { AegisError, emptyPersisted, exportOscal, findRepoRoot, getPackageState, ingestOscalPackage, loadFixture } from "../lib/aegis";
import { sha256Bytes } from "../lib/aegis/hash";
import { dataDir } from "../lib/aegis/paths";
import { remediationBlobPath } from "../lib/aegis/remediation-store";
import { exportedOscalXml } from "../lib/aegis/operations";
import { evidenceFileStatus } from "../lib/aegis/evidence";
import type { PersistedState } from "../lib/aegis/types";
import { builderStoragePrefix, persistenceMode, PIPELINE_RELEASE_PREFIX, PREVIEW_STORE_REFUSED, PRODUCTION_BLOB_STORE_ID, sessionBlobPath, setBlobIoForTests, type BlobIo } from "../lib/durable";
import { DIGEST_UNVERIFIED_CODE, DIGEST_UNVERIFIED_MESSAGE, flushRetainedWrites, locateWorkspaceEvidence, readRetained, readRetainedSync, resetRetainedForTests, retainBytes, retainedUnverified, runRetainedRequest } from "../lib/retained-bytes";
import { addEvidenceFile } from "../lib/aegis/operations";
import { evidenceBlobKey, exportBlobKey, storageKey } from "../lib/storage-key";

const root = findRepoRoot();
const support = path.join(path.dirname(fileURLToPath(import.meta.url)), "support");
const payload = "retention sample bytes";

function childEnv(dir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, AEGIS_DATA_DIR: dir };
  delete env.BLOB_READ_WRITE_TOKEN;
  delete env.VERCEL;
  delete env.VERCEL_ENV;
  delete env.BLOB_STORE_ID;
  return env;
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

function restore(name: "AEGIS_DATA_DIR" | "BLOB_READ_WRITE_TOKEN" | "VERCEL", value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function snapshotOf(dir: string, id: string): { state: PersistedState } {
  const file = path.join(dir, "sessions", id, "state.json");
  return JSON.parse(readFileSync(file, "utf8")) as { state: PersistedState };
}

describe("retained evidence and exports", { concurrency: false }, () => {
  test("storage keys share one helper", () => {
    const id = "cd".repeat(16);
    assert.equal(sessionBlobPath(id), storageKey(["sessions", id, "state.json"]));
    assert.equal(remediationBlobPath(id), storageKey(["sessions", id, "remediation.json"]));
    assert.equal(PIPELINE_RELEASE_PREFIX, `${storageKey(["pipeline-releases"])}/`);
    assert.equal(builderStoragePrefix(), `${storageKey(["builder"])}/`);
    assert.equal(evidenceBlobKey(id, "AU-2", "note.txt"), storageKey(["sessions", id, "evidence", "AU-2", "note.txt"]));
    assert.equal(exportBlobKey(id, "exp-0001-package-oscal.xml"), storageKey(["sessions", id, "exports", "exp-0001-package-oscal.xml"]));
    assert.equal(sessionBlobPath(id), `aegis/sessions/${id}/state.json`);
    assert.throws(() => storageKey([".."]), /malformed storage key/);
    assert.throws(() => evidenceBlobKey("nope", "AU-2", "note.txt"), /malformed ownership key/);
  });

  test("a fresh process reads evidence and an export, then refuses a tampered byte", async () => {
    const previousData = process.env.AEGIS_DATA_DIR;
    const previousToken = process.env.BLOB_READ_WRITE_TOKEN;
    const previousVercel = process.env.VERCEL;
    const dir = mkdtempSync(path.join(os.tmpdir(), "aegisRetain"));
    try {
      const child = spawnSync(process.execPath, ["--import", "tsx", path.join(support, "write-retained.ts")], {
        cwd: root,
        env: childEnv(dir),
        encoding: "utf8",
      });
      assert.equal(child.status, 0, child.stderr);
      assert.notEqual(child.pid, process.pid);
      const id = child.stdout.trim();
      assert.match(id, /^[a-f0-9]{32}$/);
      process.env.AEGIS_DATA_DIR = dir;
      delete process.env.BLOB_READ_WRITE_TOKEN;
      delete process.env.VERCEL;
      assert.equal(dataDir(root), dir);
      const snapshot = snapshotOf(dir, id);
      const evidence = snapshot.state.controls.find((control) => control.id === "AU-2")?.evidence.find((item) => item.title === "Retention note");
      const exported = snapshot.state.exports.at(-1);
      assert.ok(evidence?.sha256);
      assert.ok(exported?.sha256);
      assert.equal(evidence.sha256, sha256Bytes(payload));
      assert.equal(exported.filePath.startsWith("aegis/"), false);
      const ctx = { root, ownerKey: id };
      const location = locateWorkspaceEvidence(root, evidence.href, id);
      assert.ok(location);
      assert.equal(existsSync(location), true);
      const evidenceBytes = await readRetained(location, evidence.sha256, "Evidence file");
      assert.equal(evidenceBytes?.toString("utf8"), payload);
      const xml = exportedOscalXml(snapshot.state, ctx);
      assert.equal(sha256Bytes(xml), exported.sha256);
      assert.match(xml, new RegExp(`<hash algorithm="SHA-256">${evidence.sha256}</hash>`));
      const viewed = getPackageState(snapshot.state, ctx).controls.find((control) => control.id === "AU-2")?.evidence.find((item) => item.title === "Retention note");
      assert.equal(viewed?.fileStatus, "File found");
      assert.equal(viewed?.valid, true);
      const again = ingestOscalPackage({ text: xml, filename: "package-oscal.xml", catalogId: "fedramp-rev5" }, ctx);
      const kept = again.controls.find((control) => control.id === "AU-2")?.evidence.find((item) => item.title === "Retention note");
      assert.equal(kept?.sha256, evidence.sha256);
      assert.equal(evidenceFileStatus(kept!, ctx).fileStatus, "File found");

      const flipped = Buffer.from(evidenceBytes!);
      flipped[0] = flipped[0] === 0x72 ? 0x73 : 0x72;
      writeFileSync(location, flipped);
      const flagged = evidenceFileStatus(evidence, ctx);
      assert.equal(flagged.valid, false);
      assert.equal(flagged.fileStatus, "DIGEST_MISMATCH");
      await assert.rejects(readRetained(location, evidence.sha256, "Evidence file"), (error: unknown) => {
        return error instanceof AegisError && error.code === "DIGEST_MISMATCH";
      });

      const exportBytes = Buffer.from(readFileSync(exported.filePath));
      exportBytes[0] = exportBytes[0] === 0x3c ? 0x20 : 0x3c;
      writeFileSync(exported.filePath, exportBytes);
      assert.throws(() => exportedOscalXml(snapshot.state, ctx), (error: unknown) => {
        return error instanceof AegisError && error.code === "DIGEST_MISMATCH";
      });
    } finally {
      restore("AEGIS_DATA_DIR", previousData);
      restore("BLOB_READ_WRITE_TOKEN", previousToken);
      restore("VERCEL", previousVercel);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("blob storage round trip matches the recorded digest and a tampered byte is refused", async () => {
    const previousData = process.env.AEGIS_DATA_DIR;
    const previousToken = process.env.BLOB_READ_WRITE_TOKEN;
    const previousVercel = process.env.VERCEL;
    const bytes = new Map<string, Buffer>();
    const texts = new Map<string, string>();
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
        if (!allowOverwrite && bytes.has(pathname)) throw new Error("exists");
        bytes.set(pathname, Buffer.from(body));
      },
      async getBytes(pathname) {
        const found = bytes.get(pathname);
        return found ? Buffer.from(found) : null;
      },
    };
    setBlobIoForTests(io);
    const id = "ab".repeat(16);
    const outDir = path.join(os.tmpdir(), `aegisUnused${id}`);
    try {
      delete process.env.AEGIS_DATA_DIR;
      delete process.env.BLOB_READ_WRITE_TOKEN;
      delete process.env.VERCEL;
      const ctx = { root, ownerKey: id, outDir, now: () => new Date("2026-10-15T00:00:00.000Z") };
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
      const record = exported.state.exports.at(-1);
      assert.ok(evidence?.sha256);
      assert.equal(evidence.sha256, sha256Bytes(payload));
      assert.equal(record?.sha256, sha256Bytes(exported.xml));
      assert.match(exported.xml, new RegExp(`<hash algorithm="SHA-256">${evidence.sha256}</hash>`));
      assert.equal(exported.filePath, exportBlobKey(id, record!.filename));
      assert.equal(existsSync(outDir), false);
      assert.equal([...bytes.keys()].every((key) => key.startsWith("aegis/")), true);
      const evidenceKey = locateWorkspaceEvidence(root, evidence.href, id);
      assert.equal(evidenceKey, evidenceBlobKey(id, "AU-2", evidence.href.split("/").at(-1)!));
      const evidenceBytes = await readRetained(evidenceKey!, evidence.sha256, "Evidence file");
      const exportBytes = await readRetained(exported.filePath, record?.sha256, "Export");
      assert.equal(evidenceBytes?.toString("utf8"), payload);
      assert.equal(exportBytes?.toString("utf8"), exported.xml);
      assert.equal(evidenceFileStatus(evidence, ctx).fileStatus, "File found");

      const flipped = Buffer.from(evidenceBytes!);
      flipped[0] = flipped[0] === 0x72 ? 0x73 : 0x72;
      bytes.set(evidenceKey!, flipped);
      await assert.rejects(readRetained(evidenceKey!, evidence.sha256, "Evidence file"), (error: unknown) => {
        return error instanceof AegisError && error.code === "DIGEST_MISMATCH";
      });
      assert.equal(evidenceFileStatus(evidence, ctx).fileStatus, "DIGEST_MISMATCH");
      const exportFlip = Buffer.from(exportBytes!);
      exportFlip[0] = exportFlip[0] === 0x3c ? 0x20 : 0x3c;
      bytes.set(exported.filePath, exportFlip);
      await assert.rejects(readRetained(exported.filePath, record?.sha256, "Export"), (error: unknown) => {
        return error instanceof AegisError && error.code === "DIGEST_MISMATCH";
      });
      assert.throws(() => exportedOscalXml(exported.state, ctx), (error: unknown) => {
        return error instanceof AegisError && error.code === "DIGEST_MISMATCH";
      });
    } finally {
      setBlobIoForTests(null);
      resetRetainedForTests();
      restore("AEGIS_DATA_DIR", previousData);
      restore("BLOB_READ_WRITE_TOKEN", previousToken);
      restore("VERCEL", previousVercel);
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  test("verify script exercises the directory storage layer", () => {
    const previousData = process.env.AEGIS_DATA_DIR;
    const dir = mkdtempSync(path.join(os.tmpdir(), "aegisScript"));
    try {
      const child = spawnSync(process.execPath, ["--import", "tsx", path.join(root, "scripts/verifyRetainedBytes.ts")], {
        cwd: root,
        env: childEnv(dir),
        encoding: "utf8",
      });
      assert.equal(child.status, 0, child.stderr);
      assert.match(child.stdout, /round trip ok directory/);
      assert.match(child.stdout, /tamper refused/);
    } finally {
      restore("AEGIS_DATA_DIR", previousData);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("vercel without a blob token fails closed for uploads and exports", () => {
    const previousData = process.env.AEGIS_DATA_DIR;
    const previousToken = process.env.BLOB_READ_WRITE_TOKEN;
    const previousVercel = process.env.VERCEL;
    const previousEnv = process.env.VERCEL_ENV;
    const id = "ef".repeat(16);
    const outDir = path.join(os.tmpdir(), `aegisClosed${id}`);
    try {
      setBlobIoForTests(null);
      delete process.env.AEGIS_DATA_DIR;
      delete process.env.BLOB_READ_WRITE_TOKEN;
      delete process.env.VERCEL_ENV;
      process.env.VERCEL = "1";
      const uploads = path.join(dataDir(root), "uploads");
      const before = countFiles(uploads);
      const ctx = { root, ownerKey: id, outDir, now: () => new Date("2026-10-15T00:00:00.000Z") };
      const loaded = loadFixture(emptyPersisted(), "gold", ctx);
      assert.throws(() => addEvidenceFile(loaded, "AU-2", {
        filename: "retention-note.txt",
        bytes: Buffer.from(payload),
        title: "Retention note",
        type: "Document",
      }, ctx), (error: unknown) => error instanceof AegisError && error.code === "STORE_UNAVAILABLE" && /instance directory is not used/.test(error.message));
      assert.throws(() => exportOscal(loaded, ctx), (error: unknown) => error instanceof AegisError && error.code === "STORE_UNAVAILABLE");
      assert.equal(countFiles(uploads), before);
      assert.equal(existsSync(outDir), false);
    } finally {
      setBlobIoForTests(null);
      restore("AEGIS_DATA_DIR", previousData);
      restore("BLOB_READ_WRITE_TOKEN", previousToken);
      restore("VERCEL", previousVercel);
      if (previousEnv === undefined) delete process.env.VERCEL_ENV;
      else process.env.VERCEL_ENV = previousEnv;
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  test("preview refuses the production blob store", () => {
    const previous = {
      data: process.env.AEGIS_DATA_DIR,
      token: process.env.BLOB_READ_WRITE_TOKEN,
      vercel: process.env.VERCEL,
      env: process.env.VERCEL_ENV,
      store: process.env.BLOB_STORE_ID,
    };
    try {
      setBlobIoForTests(null);
      delete process.env.AEGIS_DATA_DIR;
      process.env.VERCEL = "1";
      process.env.VERCEL_ENV = "preview";
      process.env.BLOB_READ_WRITE_TOKEN = `vercel_blob_rw_${PRODUCTION_BLOB_STORE_ID}_secret`;
      delete process.env.BLOB_STORE_ID;
      assert.throws(() => persistenceMode(), new RegExp(PREVIEW_STORE_REFUSED));
      process.env.BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_TESTSTORE_fake";
      process.env.BLOB_STORE_ID = `store_${PRODUCTION_BLOB_STORE_ID}`;
      assert.throws(() => persistenceMode(), new RegExp(PREVIEW_STORE_REFUSED));
      delete process.env.BLOB_STORE_ID;
      assert.equal(persistenceMode(), "blob");
      process.env.VERCEL_ENV = "production";
      process.env.BLOB_READ_WRITE_TOKEN = `vercel_blob_rw_${PRODUCTION_BLOB_STORE_ID}_secret`;
      assert.equal(persistenceMode(), "blob");
    } finally {
      setBlobIoForTests(null);
      restore("AEGIS_DATA_DIR", previous.data);
      restore("BLOB_READ_WRITE_TOKEN", previous.token);
      restore("VERCEL", previous.vercel);
      if (previous.env === undefined) delete process.env.VERCEL_ENV;
      else process.env.VERCEL_ENV = previous.env;
      if (previous.store === undefined) delete process.env.BLOB_STORE_ID;
      else process.env.BLOB_STORE_ID = previous.store;
    }
  });

  test("upload names cannot escape the evidence directory and the size cap is enforced", () => {
    const previousData = process.env.AEGIS_DATA_DIR;
    const previousToken = process.env.BLOB_READ_WRITE_TOKEN;
    const previousVercel = process.env.VERCEL;
    const dir = mkdtempSync(path.join(os.tmpdir(), "aegisNames"));
    const id = "12".repeat(16);
    try {
      process.env.AEGIS_DATA_DIR = dir;
      delete process.env.BLOB_READ_WRITE_TOKEN;
      delete process.env.VERCEL;
      const ctx = { root, ownerKey: id, outDir: path.join(dir, "out"), now: () => new Date("2026-10-15T00:00:00.000Z") };
      const loaded = loadFixture(emptyPersisted(), "gold", ctx);
      const attacks = ["../../outside.txt", "..", "../..", "..\\..\\outside.txt", "/etc/passwd", "foo/../../AU-2/../../outside.txt"];
      let state = loaded;
      for (const filename of attacks) {
        state = addEvidenceFile(state, "AU-2", {
          filename,
          bytes: Buffer.from(payload),
          title: `Traversal ${filename}`,
          type: "Document",
        }, ctx);
      }
      const uploads = realpathSync(path.join(dir, "uploads"));
      const stored = state.controls.find((control) => control.id === "AU-2")?.evidence.filter((item) => item.title.startsWith("Traversal ")) ?? [];
      assert.equal(stored.length, attacks.length);
      for (const item of stored) {
        const location = locateWorkspaceEvidence(root, item.href, id);
        assert.ok(location);
        const resolved = realpathSync(location);
        assert.equal(resolved.startsWith(uploads + path.sep), true);
        assert.equal(resolved.split(path.sep).includes(".."), false);
      }
      const cap = 8 * 1024 * 1024;
      const before = countFiles(uploads);
      assert.throws(() => addEvidenceFile(state, "AU-2", {
        filename: "too-big.bin",
        bytes: Buffer.alloc(cap + 1),
        title: "Too big",
        type: "Document",
      }, ctx), (error: unknown) => error instanceof AegisError && error.code === "INGEST_REJECTED" && /8 MB/.test(error.message));
      assert.equal(countFiles(uploads), before);
      const accepted = addEvidenceFile(state, "AU-2", {
        filename: "exact.bin",
        bytes: Buffer.alloc(cap, 1),
        title: "Exact cap",
        type: "Document",
      }, ctx);
      assert.equal(countFiles(uploads), before + 1);
      assert.ok(accepted.controls.find((control) => control.id === "AU-2")?.evidence.some((item) => item.title === "Exact cap"));
    } finally {
      restore("AEGIS_DATA_DIR", previousData);
      restore("BLOB_READ_WRITE_TOKEN", previousToken);
      restore("VERCEL", previousVercel);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("old records without a digest return bytes and are flagged unverified", () => {
    const previousData = process.env.AEGIS_DATA_DIR;
    const previousToken = process.env.BLOB_READ_WRITE_TOKEN;
    const previousVercel = process.env.VERCEL;
    const dir = mkdtempSync(path.join(os.tmpdir(), "aegisOld"));
    const id = "34".repeat(16);
    try {
      process.env.AEGIS_DATA_DIR = dir;
      delete process.env.BLOB_READ_WRITE_TOKEN;
      delete process.env.VERCEL;
      const ctx = { root, ownerKey: id, outDir: path.join(dir, "out"), now: () => new Date("2026-10-15T00:00:00.000Z") };
      const loaded = loadFixture(emptyPersisted(), "gold", ctx);
      const gold = getPackageState(loaded, ctx).controls.find((control) => control.id === "AC-3")?.evidence[0];
      assert.equal(gold?.fileStatus, "File found");
      const withFile = addEvidenceFile(loaded, "AU-2", {
        filename: "retention-note.txt",
        bytes: Buffer.from(payload),
        title: "Old note",
        type: "Document",
      }, ctx);
      const exported = exportOscal(withFile, ctx);
      const evidence = exported.state.controls.find((control) => control.id === "AU-2")?.evidence.find((item) => item.title === "Old note");
      const record = exported.state.exports.at(-1);
      assert.ok(evidence && record);
      delete evidence.sha256;
      delete record.sha256;
      const location = locateWorkspaceEvidence(root, evidence.href, id);
      assert.ok(location);
      const status = evidenceFileStatus(evidence, ctx);
      assert.equal(status.valid, true);
      assert.equal(status.fileStatus, DIGEST_UNVERIFIED_CODE);
      assert.equal(status.errors[0], DIGEST_UNVERIFIED_MESSAGE);
      const bytes = readRetainedSync(location, undefined, "Evidence file");
      assert.equal(bytes?.toString("utf8"), payload);
      assert.equal(retainedUnverified(location), DIGEST_UNVERIFIED_MESSAGE);
      const xml = exportedOscalXml(exported.state, ctx);
      assert.equal(xml, exported.xml);
      assert.equal(retainedUnverified(record.filePath), DIGEST_UNVERIFIED_MESSAGE);
    } finally {
      restore("AEGIS_DATA_DIR", previousData);
      restore("BLOB_READ_WRITE_TOKEN", previousToken);
      restore("VERCEL", previousVercel);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a failed write does not reject another request flush", async () => {
    const previousData = process.env.AEGIS_DATA_DIR;
    const previousToken = process.env.BLOB_READ_WRITE_TOKEN;
    const previousVercel = process.env.VERCEL;
    const previousEnv = process.env.VERCEL_ENV;
    const bytes = new Map<string, Buffer>();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const io: BlobIo = {
      async put() {},
      async get() {
        return null;
      },
      async list() {
        return [];
      },
      async putBytes(pathname, body) {
        if (pathname.endsWith("fail.txt")) {
          await gate;
          throw new Error("Durable write failed.");
        }
        bytes.set(pathname, Buffer.from(body));
      },
      async getBytes(pathname) {
        const found = bytes.get(pathname);
        return found ? Buffer.from(found) : null;
      },
    };
    try {
      setBlobIoForTests(io);
      delete process.env.AEGIS_DATA_DIR;
      delete process.env.BLOB_READ_WRITE_TOKEN;
      delete process.env.VERCEL;
      delete process.env.VERCEL_ENV;
      const failKey = evidenceBlobKey("aa".repeat(16), "AU-2", "fail.txt");
      const okKey = evidenceBlobKey("bb".repeat(16), "AU-2", "ok.txt");
      const failed = runRetainedRequest(async () => {
        retainBytes({ location: failKey, bytes: Buffer.from("bad"), contentType: "application/octet-stream", label: "Evidence file" });
        await flushRetainedWrites();
      });
      const ok = runRetainedRequest(async () => {
        retainBytes({ location: okKey, bytes: Buffer.from("good"), contentType: "application/octet-stream", label: "Evidence file" });
        await flushRetainedWrites();
      });
      const finished = await Promise.race([
        ok.then(() => "ok"),
        new Promise<string>((resolve) => setTimeout(() => resolve("waited"), 1000)),
      ]);
      assert.equal(finished, "ok");
      assert.equal(bytes.get(okKey)?.toString("utf8"), "good");
      release();
      await assert.rejects(failed, /Durable write failed/);
    } finally {
      release();
      setBlobIoForTests(null);
      resetRetainedForTests();
      restore("AEGIS_DATA_DIR", previousData);
      restore("BLOB_READ_WRITE_TOKEN", previousToken);
      restore("VERCEL", previousVercel);
      if (previousEnv === undefined) delete process.env.VERCEL_ENV;
      else process.env.VERCEL_ENV = previousEnv;
    }
  });
});
