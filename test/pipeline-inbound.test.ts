import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { GET, POST } from "../app/api/pipeline/events/route";
import { PipelineEvidenceView } from "../components/binder/PipelineEvidenceView";
import { dataDir, findRepoRoot } from "../lib/aegis/paths";
import { gitlabArtifactUrl } from "../lib/aegis/pipeline-evidence";
import { controlsForArtifact } from "../lib/aegis/pipeline-evidence";
import { normalizePipelineEvent, parseStoredPipelineEvidence, PIPELINE_WEBHOOK_PATH } from "../lib/aegis/pipeline-inbound";
import { acceptPipelineEvent, readSelectedRelease, readReleaseHistory, releaseRecordKey, signPipelineBody, writeSelectedRelease } from "../lib/server/pipeline-inbound";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const HASH = "ab".repeat(32);

function event(patch: Record<string, unknown> = {}) {
  return {
    schema: "aegis.pipeline-event.v1",
    pipeline: {
      id: "build-42",
      url: "https://ci.example.test/pipelines/build-42",
      commit: COMMIT,
      createdAt: "2026-10-03T04:00:00.000Z",
    },
    image: `registry.example.test/app@sha256:${"cd".repeat(32)}`,
    releaseSha256: HASH,
    policyVerdict: "pass",
    signatureStatus: "reported",
    signatureScope: "shared-secret HMAC of this event; not a control assessment",
    deploymentVerdict: "observed",
    approval: { actor: "reviewer", approvedAt: "2026-10-03T04:05:00.000Z", commit: COMMIT, releaseSha256: HASH },
    runtime: { checkedAt: "2026-10-03T04:06:00.000Z", functionalProbe: "pass", podCount: 2, readyCount: 2, meshSidecarCount: 0, mTLS: "not assessed by this event" },
    checks: [{ id: "unit", status: "pass", findings: 1, blockingCount: 0, artifact: "unit.json" }],
    families: [{ family: "SA", controls: ["SA-11"], coverage: "Point-in-time check reported by the pipeline.", evidence: ["unit.json"] }],
    findingCount: 1,
    gaps: ["Network-policy enforcement is not established by this event."],
    artifacts: ["unit.json", "runtime.json"],
    ...patch,
  };
}

function signature(body: string, secret: string): string {
  return `sha256=${signPipelineBody(body, secret)}`;
}

test("normalize maps a vendor-neutral event into release evidence", () => {
  const record = normalizePipelineEvent(event());
  assert.equal(record.source, "Inbound pipeline event");
  assert.equal(record.schema, "ccm.application-evidence.v1");
  assert.equal(record.pipelineId, "build-42");
  assert.equal(record.pipelineUrl, "https://ci.example.test/pipelines/build-42");
  assert.equal(record.commitSha, COMMIT);
  assert.equal(record.policyVerdict, "pass");
  assert.equal(record.artifactJobId, "");
  assert.deepEqual(record.artifacts, ["unit.json", "runtime.json"]);
  assert.deepEqual(controlsForArtifact(record, "unit.json"), ["SA-11"]);
  assert.equal(gitlabArtifactUrl(record, "unit.json"), null);
  assert.equal("validationRecorded" in record, false);
  assert.equal("closure" in record, false);
  assert.deepEqual(parseStoredPipelineEvidence(record), record);
});

test("normalize rejects a non-https url, a mismatched approval, and an unsafe artifact name", () => {
  assert.throws(() => normalizePipelineEvent({ ...event(), schema: "vendor.pipeline" }), /aegis\.pipeline-event\.v1/);
  const http = event();
  http.pipeline = { ...http.pipeline, url: "http://ci.example.test/pipelines/build-42" };
  assert.throws(() => normalizePipelineEvent(http), /pipeline URL/);
  const embedded = event();
  embedded.pipeline = { ...embedded.pipeline, url: "https://user:secret@ci.example.test/pipelines/build-42" };
  assert.throws(() => normalizePipelineEvent(embedded), (error: unknown) => {
    assert.match((error as Error).message, /pipeline URL/);
    assert.equal((error as Error).message.includes("secret"), false);
    return true;
  });
  const mismatch = event();
  mismatch.approval = { ...mismatch.approval, releaseSha256: "ff".repeat(32) };
  assert.throws(() => normalizePipelineEvent(mismatch), /Approval does not match/);
  assert.throws(() => normalizePipelineEvent(event({ artifacts: ["../secret.json"] })), /artifact inventory/);
  const counts = event();
  counts.runtime = { ...counts.runtime, readyCount: 3 };
  assert.throws(() => normalizePipelineEvent(counts), /runtime counts/);
});

test("accept stores a signed event and reject leaves the selected release unset", async () => {
  const secret = "unit-test-secret";
  const body = JSON.stringify(event());
  const accepted = acceptPipelineEvent(body, signature(body, secret), secret);
  assert.equal(accepted.ok, true);
  if (!accepted.ok) return;
  assert.equal(accepted.evidence.pipelineId, "build-42");
  assert.equal(acceptPipelineEvent(body, signature(body, secret), null).ok, false);
  assert.equal(acceptPipelineEvent(body, null, secret).ok, false);
  const wrong = acceptPipelineEvent(body, signature(body, "other-secret"), secret);
  assert.equal(wrong.ok, false);
  if (wrong.ok) return;
  assert.equal(wrong.status, 401);
  assert.equal(wrong.message.includes(secret), false);
  const malformed = acceptPipelineEvent("{", signature("{", secret), secret);
  assert.equal(malformed.ok, false);
  if (!malformed.ok) assert.equal(malformed.message.includes("{"), false);

  const previous = process.env.AEGIS_DATA_DIR;
  const dir = mkdtempSync(path.join(os.tmpdir(), "aegis-pipeline-"));
  try {
    process.env.AEGIS_DATA_DIR = dir;
    assert.equal(await readSelectedRelease(), null);
    await writeSelectedRelease({ receivedAt: "2026-10-03T04:07:00.000Z", evidence: accepted.evidence });
    const stored = await readSelectedRelease();
    assert.equal(stored?.evidence.pipelineId, "build-42");
    assert.equal(stored?.evidence.commitSha, COMMIT);
    const replaced = normalizePipelineEvent(event({ pipeline: { ...event().pipeline, id: "build-43" } }));
    await writeSelectedRelease({ receivedAt: "2026-10-03T05:00:00.000Z", evidence: replaced });
    assert.equal((await readSelectedRelease())?.evidence.pipelineId, "build-43");
    const file = path.join(dataDir(findRepoRoot()), "pipeline-inbound", "history", `${releaseRecordKey(replaced)}.json`);
    const raw = readFileSync(file, "utf8");
    assert.equal(raw.includes("validationRecorded"), false);
    assert.equal(raw.includes(secret), false);
  } finally {
    if (previous === undefined) delete process.env.AEGIS_DATA_DIR;
    else process.env.AEGIS_DATA_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("webhook route accepts one signed event, rejects a bad signature, and does not return the secret", async () => {
  const secret = "route-test-secret";
  const previousData = process.env.AEGIS_DATA_DIR;
  const previousSecret = process.env.AEGIS_PIPELINE_WEBHOOK_SECRET;
  const dir = mkdtempSync(path.join(os.tmpdir(), "aegis-pipeline-route-"));
  const logged: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { logged.push(args); };
  try {
    process.env.AEGIS_DATA_DIR = dir;
    delete process.env.AEGIS_PIPELINE_WEBHOOK_SECRET;
    const unsigned = JSON.stringify(event());
    const missing = await POST(new Request("http://127.0.0.1/api/pipeline/events", { method: "POST", body: unsigned }));
    assert.equal(missing.status, 401);
    const missingBody = await missing.json() as { error: { code: string; message: string } };
    assert.equal(missingBody.error.code, "WEBHOOK_UNCONFIGURED");
    assert.equal(await readSelectedRelease(), null);

    process.env.AEGIS_PIPELINE_WEBHOOK_SECRET = secret;
    const bad = await POST(new Request("http://127.0.0.1/api/pipeline/events", {
      method: "POST",
      headers: { "x-aegis-signature": `sha256=${createHmac("sha256", "nope").update(unsigned).digest("hex")}` },
      body: unsigned,
    }));
    assert.equal(bad.status, 401);
    assert.equal(await readSelectedRelease(), null);

    const response = await POST(new Request("http://127.0.0.1/api/pipeline/events", {
      method: "POST",
      headers: { "content-type": "application/json", "x-aegis-signature": signature(unsigned, secret) },
      body: unsigned,
    }));
    assert.equal(response.status, 200);
    const posted = await response.json() as { ok: boolean; pipelineId: string; commitSha: string };
    assert.equal(posted.ok, true);
    assert.equal(posted.pipelineId, "build-42");
    assert.equal(posted.commitSha, COMMIT);
    assert.equal(JSON.stringify(posted).includes(secret), false);

    const read = await GET();
    const payload = await read.json() as { configured: boolean; webhookPath: string; evidence: { pipelineId: string; source: string; policyVerdict: string } };
    assert.equal(payload.configured, true);
    assert.equal(payload.webhookPath, PIPELINE_WEBHOOK_PATH);
    assert.equal(payload.evidence.pipelineId, "build-42");
    assert.equal(payload.evidence.source, "Inbound pipeline event");
    assert.equal(payload.evidence.policyVerdict, "pass");
    assert.equal(JSON.stringify(payload).includes(secret), false);
    assert.equal(logged.some((args) => JSON.stringify(args).includes(secret) || JSON.stringify(args).includes(unsigned)), false);
  } finally {
    console.error = original;
    if (previousData === undefined) delete process.env.AEGIS_DATA_DIR;
    else process.env.AEGIS_DATA_DIR = previousData;
    if (previousSecret === undefined) delete process.env.AEGIS_PIPELINE_WEBHOOK_SECRET;
    else process.env.AEGIS_PIPELINE_WEBHOOK_SECRET = previousSecret;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("release screen shows the webhook path and a received event without an authorization claim", () => {
  const record = normalizePipelineEvent(event());
  const markup = renderToStaticMarkup(createElement(PipelineEvidenceView, {
    record,
    connection: { configured: true, webhookPath: PIPELINE_WEBHOOK_PATH, receivedAt: "2026-10-03T04:07:00.000Z", inboundSelected: true },
  }));
  assert.match(markup, /POST \/api\/pipeline\/events/);
  assert.match(markup, /Connection configured/);
  assert.match(markup, /showing the received event/);
  assert.match(markup, /#build-42/);
  assert.match(markup, /0123456789ab/);
  assert.match(markup, /Pipeline run/);
  assert.match(markup, /does not record validation or closure/);
  assert.match(markup, /No FedRAMP authorization or agency ATO/);
  assert.doesNotMatch(markup, /GitLab pipeline/);
  assert.equal(markup.includes("unit-test-secret"), false);
});

test("inbound modules do not name a pipeline vendor", () => {
  for (const relative of ["../lib/aegis/pipeline-inbound.ts", "../lib/server/pipeline-inbound.ts", "../app/api/pipeline/events/route.ts"]) {
    const source = readFileSync(new URL(relative, import.meta.url), "utf8");
    assert.equal(/gitlab|github|gitkraken/i.test(source), false);
  }
});

test("deployment review mode survives normalization and conflicts are rejected", () => {
  const value = event();
  const record = normalizePipelineEvent({ ...value, approval: { ...value.approval, mode: "vendor-test", independentReview: false } });
  assert.equal(parseStoredPipelineEvidence(record).approval.mode, "vendor-test");
  assert.throws(() => normalizePipelineEvent({ ...value, approval: { ...value.approval, mode: "independent-review", independentReview: false } }), /Conflicting/);
});

test("duplicate notification is idempotent and prior releases remain available", async () => {
  const previous = process.env.AEGIS_DATA_DIR, dir = mkdtempSync(path.join(os.tmpdir(), "aegis-history-"));
  try {
    process.env.AEGIS_DATA_DIR = dir;
    const record = normalizePipelineEvent(event());
    await writeSelectedRelease({ evidence: record, receivedAt: "2026-10-03T05:00:00Z" });
    const duplicate = await writeSelectedRelease({ evidence: record, receivedAt: "2026-10-03T06:00:00Z" });
    assert.equal(duplicate.receivedAt, "2026-10-03T05:00:00Z");
    const next = normalizePipelineEvent(event({ pipeline: { ...event().pipeline, id: "build-43", url: "https://ci.example.test/pipelines/build-43", createdAt: "2026-10-03T07:00:00Z" } }));
    await writeSelectedRelease({ evidence: next, receivedAt: "2026-10-03T07:00:00Z" });
    assert.deepEqual((await readReleaseHistory()).map(r => r.evidence.pipelineId), ["build-43", "build-42"]);
  } finally {
    if (previous == null) delete process.env.AEGIS_DATA_DIR; else process.env.AEGIS_DATA_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("production will not acknowledge ephemeral-only storage", async () => {
  const previous = process.env.VERCEL, token = process.env.BLOB_READ_WRITE_TOKEN;
  try {
    process.env.VERCEL = "1"; delete process.env.BLOB_READ_WRITE_TOKEN;
    await assert.rejects(() => writeSelectedRelease({ evidence: normalizePipelineEvent(event()), receivedAt: "2026-10-03T07:00:00Z" }), /Durable/);
  } finally {
    if (previous == null) delete process.env.VERCEL; else process.env.VERCEL = previous;
    if (token != null) process.env.BLOB_READ_WRITE_TOKEN = token;
  }
});


test("scoped finding records survive inbound storage and reject an artifact outside the source inventory", () => {
  const item = { id: "recorded-finding", description: "A producer-recorded finding for an independent test release.", scope: { title: "Recorded finding", asset: "Test workload", controls: ["SA-11"], framework: "Test catalog", baseline: "Test policy", artifacts: ["unit.json"], verification: ["Rerun proves the finding absent"], remainingScope: [] } };
  const input = { ...event(), reviewItems: [item] };
  const stored = normalizePipelineEvent(input);
  assert.deepEqual(parseStoredPipelineEvidence(stored).reviewItems, [item]);
  assert.throws(() => normalizePipelineEvent({ ...input, reviewItems: [{ ...item, scope: { ...item.scope, artifacts: ["unlisted.json"] } }] }), /source artifact/);
  assert.throws(() => normalizePipelineEvent({ ...input, reviewItems: [item, item] }), /Duplicate review/);
});
