import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { findRepoRoot } from "../lib/aegis/paths";
import { EVIDENCE_EXPORTS, SCHEMA_IDS, SOURCE_KINDS, assertSourceKind } from "../lib/collector/registry";

const root = findRepoRoot();

function walk(dir: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules") continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) files.push(...walk(full));
    else if (/\.(?:ts|tsx|mts|mjs)$/.test(name)) files.push(full);
  }
  return files;
}

test("schema ids emitted in lib are registered", () => {
  const found = new Set<string>();
  for (const file of walk(path.join(root, "lib"))) {
    for (const match of readFileSync(file, "utf8").matchAll(/schema:\s*["']([^"']+)["']/g)) found.add(match[1]);
  }
  const allowed = new Set<string>(SCHEMA_IDS);
  const extra = [...found].filter((id) => !allowed.has(id)).sort();
  assert.deepEqual(extra, []);
  assert.ok(found.has("aegis.collected-artifact.v1"));
  assert.ok(found.has("aegis.aws-scan-record/v1"));
});

test("evidence export names in lib are registered", () => {
  const found = new Set<string>();
  const interesting = /Evidence|CollectedArtifact|ScanRecord|SourceKind/;
  for (const file of walk(path.join(root, "lib"))) {
    for (const match of readFileSync(file, "utf8").matchAll(/^export (?:type|interface) (\w+)/gm)) {
      const name = match[1];
      if (name && interesting.test(name)) found.add(name);
    }
  }
  const allowed = new Set<string>(EVIDENCE_EXPORTS);
  const extra = [...found].filter((name) => !allowed.has(name)).sort();
  assert.deepEqual(extra, []);
  assert.ok(found.has("CollectedArtifact"));
  assert.ok(found.has("AwsScanRecord"));
  assert.ok(found.has("SourceKind"));
});

test("collector source kinds are registered", () => {
  const found = new Set<string>();
  for (const file of walk(path.join(root, "lib/collector"))) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!/(?:sourceKind|\bkind)\??\s*(?::|===|!==)/.test(line) || /\bsubject\b/.test(line)) continue;
      for (const match of line.matchAll(/["']([a-z]+(?:-[a-z0-9]+)+)["']/g)) {
        const kind = match[1];
        if (kind) found.add(kind);
      }
    }
  }
  const allowed = new Set<string>(SOURCE_KINDS);
  const extra = [...found].filter((kind) => !allowed.has(kind)).sort();
  assert.deepEqual(extra, []);
  assert.deepEqual([...found].sort(), [...SOURCE_KINDS].sort());
  assert.throws(() => assertSourceKind("gcp-account"), /not registered/);
});
