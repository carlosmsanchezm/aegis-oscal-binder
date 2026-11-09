import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, platform } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { buildPackageSsp, findRepoRoot, getPackageState, ingestOscalPackage } from "../lib/aegis";
import { sealMeasurement, type MeasurementPayload, type MeasurementSample } from "../lib/aegis/measurement";
import { profileControlCounts } from "../lib/aegis/profile-counts";
import { roundTripPackage } from "../lib/aegis/round-trip";
import { sspSchemaReport } from "../lib/aegis/ssp-schema-report";
import type { Ctx } from "../lib/aegis/types";

const RUNS = 5;
const root = findRepoRoot();

function sample(runs: number[]): MeasurementSample {
  const sorted = [...runs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  return {
    min: sorted[0]!,
    median,
    max: sorted[sorted.length - 1]!,
    unit: "ms",
    runs,
  };
}

function roundMs(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function commitSha(): string {
  try {
    const sha = execSync("git rev-parse HEAD", { cwd: root, encoding: "utf8" }).trim();
    const dirty = execSync("git status --porcelain", { cwd: root, encoding: "utf8" }).trim();
    return dirty ? `${sha}-dirty` : sha;
  } catch {
    return "unknown";
  }
}

const ctx: Ctx = { root, now: () => new Date("2026-10-15T12:00:00.000Z") };
const text = readFileSync(path.join(root, "public/samples/sample-oscal-ssp-rev5-moderate.json"), "utf8");
const counts = profileControlCounts(root);
const importRuns: number[] = [];
const gateRuns: number[] = [];
const exportRuns: number[] = [];
const schemaRuns: number[] = [];
const roundRuns: number[] = [];

for (let index = 0; index < RUNS; index += 1) {
  const importStarted = performance.now();
  const state = ingestOscalPackage({
    text,
    filename: "sample-oscal-ssp-rev5-moderate.json",
    catalogId: "fedramp-rev5",
  }, ctx);
  importRuns.push(roundMs(performance.now() - importStarted));

  const gateStarted = performance.now();
  const pkg = getPackageState(state, ctx);
  gateRuns.push(roundMs(performance.now() - gateStarted));
  if (pkg.controls.length !== counts.total) {
    throw new Error(`Resolved ${pkg.controls.length} controls. Profile file has ${counts.total}.`);
  }

  const exportStarted = performance.now();
  const document = buildPackageSsp(state, new Date("2026-10-15T12:00:00.000Z"));
  exportRuns.push(roundMs(performance.now() - exportStarted));

  const schemaStarted = performance.now();
  sspSchemaReport(document, "2026-10-15T12:00:00.000Z");
  schemaRuns.push(roundMs(performance.now() - schemaStarted));

  const roundStarted = performance.now();
  roundTripPackage(state, ctx);
  roundRuns.push(roundMs(performance.now() - roundStarted));
}

const recorded = {
  import: sample(importRuns),
  gate: sample(gateRuns),
  export: sample(exportRuns),
  schema: sample(schemaRuns),
  roundTrip: sample(roundRuns),
};
const ceilings = Object.fromEntries(Object.entries(recorded).map(([name, item]) => [name, Math.ceil(item.max * 3)]));
const payload: MeasurementPayload = {
  controls: counts.total,
  runs: RUNS,
  commit: commitSha(),
  node: process.version,
  platform: platform(),
  cpuCount: cpus().length,
  recordedAt: new Date().toISOString(),
  samples: recorded,
  proposal: `Record only. These timings do not fail a build. A later limit could use three times each recorded max (${Object.entries(ceilings).map(([name, value]) => `${name} ${value} ms`).join(", ")}). No limit is in force.`,
};

const sealed = sealMeasurement(payload);
const dir = path.join(root, "fixtures", "measurements");
mkdirSync(dir, { recursive: true });
writeFileSync(path.join(dir, "323.json"), `${JSON.stringify(sealed, null, 2)}\n`);

const lines = [
  "# Performance at the resolved Moderate profile",
  "",
  "Measured on this machine by `pnpm exec tsx scripts/measure323.ts`. The script imports the public FedRAMP Moderate sample, which resolves through the vendored profile, then times the gate, the JSON SSP export, official schema validation, and an unedited round trip. Five runs. The numbers below are that recording.",
  "",
  `Controls resolved: ${payload.controls}. Commit: \`${payload.commit}\`. Node ${payload.node}. Platform ${payload.platform}. CPUs ${payload.cpuCount}. Recorded at ${payload.recordedAt}.`,
  "",
  "| Step | min ms | median ms | max ms |",
  "| --- | ---: | ---: | ---: |",
  ...Object.entries(payload.samples).map(([name, item]) => `| ${name} | ${item.min} | ${item.median} | ${item.max} |`),
  "",
  payload.proposal,
  "",
  "The route `GET /api/measurements/323` returns this recording when the digest matches. It returns `measurement: null` with `NO_MEASUREMENT`, `MEASUREMENT_UNREADABLE`, or `DIGEST_MISMATCH` otherwise. Nothing in the test suite fails when a later run is slower.",
  "",
];
writeFileSync(path.join(root, "docs", "perf-323.md"), lines.join("\n"));
console.log(JSON.stringify({ commit: payload.commit, controls: payload.controls, samples: payload.samples, proposal: payload.proposal }, null, 2));
