import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

// Exercise the actual npm build entry point with a controlled compiler, so a
// missing manifest or competing writer is deterministic rather than a flake.
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "binder-build-regression-"));
  const script = readFileSync(new URL("../package.json", import.meta.url), "utf8");
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ type: "module", scripts: { build: JSON.parse(script).scripts.build } }));
  mkdirSync(path.join(root, "scripts"));
  const wrapper = new URL("../scripts/production-build.mjs", import.meta.url);
  if (existsSync(wrapper)) copyFileSync(wrapper, path.join(root, "scripts", "production-build.mjs"));
  const cliDir = path.join(root, "node_modules", "next", "dist", "bin");
  mkdirSync(cliDir, { recursive: true });
  writeFileSync(path.join(root, "node_modules", "next", "package.json"), '{"type":"commonjs"}');
  const cli = path.join(cliDir, "next.js");
  writeFileSync(cli, `#!/usr/bin/env node
const fs = require('node:fs');
const duplicate = fs.existsSync('started');
fs.appendFileSync('started', process.pid + '\\n');
fs.rmSync('.next', {recursive:true, force:true});
const timer = setInterval(() => {
  if (!duplicate && !fs.existsSync('release')) return;
  clearInterval(timer);
  if (fs.existsSync('fail')) process.exit(7);
  fs.mkdirSync('.next/server/pages', {recursive:true});
  fs.writeFileSync('.next/server/pages/page.js', 'module.exports = {}');
  fs.writeFileSync('.next/BUILD_ID', 'throwaway-build');
  if (!fs.existsSync('omit-manifest')) fs.writeFileSync('.next/server/pages-manifest.json', JSON.stringify({'/':'pages/page.js'}));
}, 10);
`);
  chmodSync(cli, 0o755);
  mkdirSync(path.join(root, "node_modules", ".bin"));
  symlinkSync(cli, path.join(root, "node_modules", ".bin", "next"));
  return root;
}

function build(root: string, direct = false) {
  const child = direct ? spawn(process.execPath, ["scripts/production-build.mjs"], { cwd: root }) : spawn("npm", ["run", "build"], { cwd: root });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  const done = new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", code => resolve({ code, output }));
  });
  return { child, done };
}

async function started(root: string) {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (existsSync(path.join(root, "started"))) return;
    await delay(10);
  }
  throw new Error("Controlled compiler did not start");
}

test("production build rejects an overlapping writer before it can clear .next", async () => {
  const root = fixture();
  const first = build(root);
  try {
    await started(root);
    const second = await build(root).done;
    assert.equal(second.code, 1, second.output);
    assert.match(second.output, /already owns this checkout/);
    assert.equal(readFileSync(path.join(root, "started"), "utf8").trim().split("\n").length, 1);
  } finally {
    writeFileSync(path.join(root, "release"), "");
    const result = await first.done;
    assert.equal(result.code, 0, result.output);
    assert.equal(existsSync(path.join(root, ".aegis-build.lock")), false);
    rmSync(root, { recursive: true, force: true });
  }
});

test("production build treats a symlinked checkout as the same writer", async () => {
  const root = fixture(), alias = `${root}-alias`;
  symlinkSync(root, alias);
  const first = build(root);
  try {
    await started(root);
    const second = await build(alias).done;
    assert.equal(second.code, 1, second.output);
    assert.match(second.output, /already owns this checkout/);
  } finally {
    writeFileSync(path.join(root, "release"), "");
    await first.done;
    unlinkSync(alias); rmSync(root, { recursive: true, force: true });
  }
});

test("production build fails when a successful compiler leaves no pages manifest", async () => {
  const root = fixture();
  try {
    writeFileSync(path.join(root, "omit-manifest"), "");
    writeFileSync(path.join(root, "release"), "");
    const result = await build(root).done;
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /pages-manifest.json/);
    assert.equal(existsSync(path.join(root, ".aegis-build.lock")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("production build preserves a compiler failure and permits a later build", async () => {
  const root = fixture();
  try {
    writeFileSync(path.join(root, "fail"), "");
    writeFileSync(path.join(root, "release"), "");
    assert.equal((await build(root).done).code, 7);
    assert.equal(existsSync(path.join(root, ".aegis-build.lock")), false);
    rmSync(path.join(root, "fail"));
    const next = await build(root).done;
    assert.equal(next.code, 0, next.output);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("production build allows separate checkouts to compile concurrently", async () => {
  const a = fixture(), b = fixture();
  const first = build(a), second = build(b);
  try { await Promise.all([started(a), started(b)]); }
  finally {
    for (const root of [a, b]) writeFileSync(path.join(root, "release"), "");
    for (const result of await Promise.all([first.done, second.done])) assert.equal(result.code, 0, result.output);
    for (const root of [a, b]) rmSync(root, { recursive: true, force: true });
  }
});

test("an interrupted production compiler releases its checkout lock", async () => {
  const root = fixture(), active = build(root, true);
  try {
    await started(root);
    active.child.kill("SIGTERM");
    const stopped = await active.done;
    assert.equal(stopped.code, 143, stopped.output);
    assert.equal(existsSync(path.join(root, ".aegis-build.lock")), false);
    writeFileSync(path.join(root, "release"), "");
    const next = await build(root).done;
    assert.equal(next.code, 0, next.output);
  } finally {
    active.child.kill("SIGTERM");
    rmSync(root, { recursive: true, force: true });
  }
});
