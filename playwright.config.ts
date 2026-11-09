import { defineConfig, devices } from "@playwright/test";
import {execFileSync} from "node:child_process";
import {randomInt} from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Archive exports do not have Git metadata. The caller supplies the archive SHA.
let checkoutId=process.env.AEGIS_TEST_SHA ?? "archive";
try {checkoutId=execFileSync("git",["rev-parse","--short","HEAD"],{encoding:"utf8",stdio:["ignore","pipe","ignore"]}).trim();} catch { /* Retain the explicit SHA or archive fallback. */ }

const port = Number(process.env.AEGIS_TEST_PORT ?? 3000);
const baseURL = `http://127.0.0.1:${port}`;
const testArtifactDir = process.env.AEGIS_TEST_OUTPUT_DIR ?? mkdtempSync(path.join(tmpdir(), `binder-e2e-artifacts-${checkoutId}-`));
process.env.AEGIS_TEST_OUTPUT_DIR = testArtifactDir;
// The existing random-package helper reads this first. Pass one fresh run seed
// to loader and workers instead of racing its shared temporary seed file.
process.env.UPLOAD_PACKAGE_SEED ??= String(randomInt(1, 1_000_000_001));
const testDataDir = process.env.AEGIS_E2E_DATA_DIR ??= mkdtempSync(path.join(tmpdir(), `binder-e2e-${checkoutId}-`));

export default defineConfig({
  testDir: "./e2e",
  // The production, no-durable-store story has its own server configuration.
  testIgnore: ["plan-proposals.spec.ts", "preview-accept.spec.ts"],
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  outputDir: path.join(testArtifactDir,"results"),
  reporter: [["list"], ["html", { open: "never", outputFolder: process.env.PLAYWRIGHT_HTML_OUTPUT_DIR ?? path.join(testArtifactDir,"html") }]],
  use: {
    baseURL,
    viewport: { width: 1280, height: 800 },
    actionTimeout: 15_000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } },
    },
  ],
  webServer: {
    command: `pnpm start --port ${port}`,
    env: { BLOB_READ_WRITE_TOKEN: "", AEGIS_DATA_DIR: testDataDir, AEGIS_PIPELINE_WEBHOOK_SECRET: "local-browser-test-only", AEGIS_DEMO_COOKIE_KEY: "a1".repeat(32), AEGIS_REMEDIATION_COOKIE_KEY: "b2".repeat(32), AEGIS_BUILDER_COOKIE_KEY: "c3".repeat(32), AUTH_SECRET: "local-browser-test-account-secret", AEGIS_AUTH_TEST: "1" },
    url: baseURL,
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
