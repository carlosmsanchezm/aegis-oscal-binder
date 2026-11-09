import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { commitLabel, shortCommit } from "../lib/aegis/build";
import { dataDir } from "../lib/aegis/paths";
import { createLocalFileStorage } from "../lib/storage";

describe("portability", { concurrency: false }, () => {
  test("commit label prefers AEGIS_COMMIT, then the hosted SHA, then local", () => {
    const previousCommit = process.env.AEGIS_COMMIT;
    const previousHosted = process.env.VERCEL_GIT_COMMIT_SHA;
    try {
      process.env.AEGIS_COMMIT = "abc1234ffff";
      process.env.VERCEL_GIT_COMMIT_SHA = "fffffff111111";
      assert.equal(commitLabel(), "abc1234");
      delete process.env.AEGIS_COMMIT;
      process.env.VERCEL_GIT_COMMIT_SHA = "fffffff111111";
      assert.equal(commitLabel(), "fffffff");
      delete process.env.VERCEL_GIT_COMMIT_SHA;
      assert.equal(commitLabel(), "unknown");
      assert.equal(shortCommit("8dd9b7e4c0ff"), "8dd9b7e");
    } finally {
      restoreEnv("AEGIS_COMMIT", previousCommit);
      restoreEnv("VERCEL_GIT_COMMIT_SHA", previousHosted);
    }
  });

  test("dataDir uses AEGIS_DATA_DIR and ignores VERCEL", () => {
    const previousData = process.env.AEGIS_DATA_DIR;
    const previousVercel = process.env.VERCEL;
    const configured = mkdtempSync(path.join(os.tmpdir(), "aegis-data-dir-"));
    const root = mkdtempSync(path.join(os.tmpdir(), "aegis-root-"));
    try {
      process.env.AEGIS_DATA_DIR = configured;
      process.env.VERCEL = "1";
      assert.equal(dataDir(root), configured);
      assert.equal(dataDir("/unused"), configured);
    } finally {
      restoreEnv("AEGIS_DATA_DIR", previousData);
      restoreEnv("VERCEL", previousVercel);
      rmSync(configured, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("dataDir defaults to .data when that path is writable", () => {
    const previousData = process.env.AEGIS_DATA_DIR;
    const previousVercel = process.env.VERCEL;
    const root = mkdtempSync(path.join(os.tmpdir(), "aegis-root-"));
    try {
      delete process.env.AEGIS_DATA_DIR;
      process.env.VERCEL = "1";
      assert.equal(dataDir(root), path.join(root, ".data"));
    } finally {
      restoreEnv("AEGIS_DATA_DIR", previousData);
      restoreEnv("VERCEL", previousVercel);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("dataDir uses the OS temp directory when .data cannot be created", () => {
    const previousData = process.env.AEGIS_DATA_DIR;
    const previousVercel = process.env.VERCEL;
    const root = mkdtempSync(path.join(os.tmpdir(), "aegis-ro-"));
    chmodSync(root, 0o555);
    try {
      delete process.env.AEGIS_DATA_DIR;
      process.env.VERCEL = "1";
      assert.equal(dataDir(root), path.join(os.tmpdir(), "aegis-data"));
    } finally {
      chmodSync(root, 0o755);
      restoreEnv("AEGIS_DATA_DIR", previousData);
      restoreEnv("VERCEL", previousVercel);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("paths.ts does not branch on VERCEL", () => {
    const source = readFileSync(new URL("../lib/aegis/paths.ts", import.meta.url), "utf8");
    assert.equal(source.includes("VERCEL"), false);
  });

  test("local file storage round-trips bytes", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "aegis-store-"));
    const file = path.join(dir, "nested", "note.txt");
    const storage = createLocalFileStorage();
    try {
      assert.equal(storage.exists(file), false);
      storage.write(file, "wip");
      assert.equal(storage.exists(file), true);
      assert.equal(storage.read(file).toString("utf8"), "wip");
      storage.remove(file);
      assert.equal(storage.exists(file), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function restoreEnv(name: "AEGIS_COMMIT" | "AEGIS_DATA_DIR" | "VERCEL_GIT_COMMIT_SHA" | "VERCEL", value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
