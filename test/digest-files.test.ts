import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { getPackageState, emptyPersisted, loadFixture, addEvidenceFile, findRepoRoot, exportOscal } from "../lib/aegis";
import { compareStoredFile, storedFileInventory, lastDigestCheck, regenerateStoredExport } from "../lib/digest-recovery";
import { outDir } from "../lib/aegis/store";
import { listDigestAudits } from "../lib/digest-audit";
import { locateWorkspaceEvidence, readRetainedSync } from "../lib/retained-bytes";

test("per file comparisons are fresh, owned and do not write an audit or replace a pass", async () => {
  const previous = process.env.AEGIS_DATA_DIR;
  const dir = mkdtempSync(path.join(tmpdir(), "digest-file-check-"));
  process.env.AEGIS_DATA_DIR = dir;
  try {
    const ctx = { root: findRepoRoot(), ownerKey: "ae".repeat(16), now: () => new Date("2026-10-06T18:39:19Z") };
    const state = addEvidenceFile(loadFixture(emptyPersisted(), "gold", ctx), "AC-6", { filename: "original.json", bytes: Buffer.from('{"ok":true}'), title: "Stored evidence", type: "Document" }, ctx);
    const [file] = storedFileInventory(state, ctx);
    assert.ok(file);
    assert.equal(file.storedAt, "2026-10-06T18:39:19.000Z");
    assert.equal(file.filename, "original.json");
    assert.equal((await compareStoredFile(state, ctx, file.objectKey)).result, "match");
    const evidence = state.controls.find(item => item.id === "AC-6")!.evidence.at(-1)!;
    const location = locateWorkspaceEvidence(ctx.root, evidence.href, ctx.ownerKey)!;
    const original = readFileSync(location);
    const changed = Buffer.from(original); changed[0] ^= 1; writeFileSync(location, changed);
    assert.equal((await compareStoredFile(state, ctx, file.objectKey)).result, "mismatch");
    assert.deepEqual(readFileSync(location), changed);
    assert.equal(getPackageState(state, ctx).controls.find(item => item.id === "AC-6")!.evidence.at(-1)!.fileStatus, "DIGEST_MISMATCH");
    assert.deepEqual((await listDigestAudits(ctx.ownerKey)).entries, []);
    assert.equal(await lastDigestCheck(ctx), null);
    writeFileSync(location, original);
    assert.deepEqual(readRetainedSync(location, file.recordedDigest!, "Evidence file", { recordAudit: false }), original);
    assert.equal((await compareStoredFile(state, ctx, file.objectKey)).result, "match");
    await assert.rejects(compareStoredFile(state, ctx, "b".repeat(64)), /No stored file/);
  } finally {
    if (previous === undefined) delete process.env.AEGIS_DATA_DIR; else process.env.AEGIS_DATA_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the additive M1 operation creates a current package export without replacing the refused record", async () => {
  const previous = process.env.AEGIS_DATA_DIR;
  const dir = mkdtempSync(path.join(tmpdir(), "digest-new-export-"));
  process.env.AEGIS_DATA_DIR = dir;
  try {
    const ctx = { root: findRepoRoot(), ownerKey: "ab".repeat(16), now: () => new Date("2026-10-06T18:39:19Z") };
    const first = exportOscal(loadFixture(emptyPersisted(), "gold", ctx), { ...ctx, outDir: outDir(ctx.root, ctx.ownerKey) });
    const original = readFileSync(first.filePath);
    const changed = Buffer.from(original); changed[0] ^= 1; writeFileSync(first.filePath, changed);
    const current = structuredClone(first.state);
    current.controls.find(control => control.id === "AC-6")!.implementation = "Current package narrative for explicit new export recovery.";
    const result = await regenerateStoredExport(current, ctx, { exportId: first.exportId, newExport: true });
    assert.equal(result.regenerated.exportId, "exp-0002");
    assert.equal(result.state.exports.length, 2);
    assert.equal(result.state.exports[0]!.filePath, first.filePath);
    assert.equal(result.state.exports[1]!.regeneratedFrom, first.exportId);
    assert.deepEqual(readFileSync(first.filePath), changed);
    assert.match(result.state.exports[1]!.xml!, /Current package narrative for explicit new export recovery/);
    assert.deepEqual(result.state.baseline, current.baseline);
    assert.ok(["GREEN", "RED"].includes(result.regenerated.validatorStatus!));
    await assert.rejects(regenerateStoredExport(result.state, ctx, { exportId: result.regenerated.exportId, newExport: true }), /Stored bytes match/);
  } finally {
    if (previous === undefined) delete process.env.AEGIS_DATA_DIR; else process.env.AEGIS_DATA_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
