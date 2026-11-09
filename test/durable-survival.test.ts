import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { GET as getPackage } from "../app/api/package/route";
import { POST as selectCatalog } from "../app/api/catalogs/select/route";
import { POST as loadFixture } from "../app/api/fixtures/load/route";
import { GET } from "../app/api/pipeline/events/route";
import { emptyPersisted, findRepoRoot } from "../lib/aegis";
import { normalizePipelineEvent } from "../lib/aegis/pipeline-inbound";
import { Session, dropCachedSession } from "../lib/aegis/store";
import { setBlobIoForTests, type BlobIo } from "../lib/durable";
import { releaseRecordKey, writeSelectedRelease, readSelectedRelease } from "../lib/server/pipeline-inbound";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const HASH = "ab".repeat(32);
const root = findRepoRoot();
const support = path.join(path.dirname(fileURLToPath(import.meta.url)), "support");

function event(id = "build-42") {
  return {
    schema: "aegis.pipeline-event.v1",
    pipeline: {
      id,
      url: `https://ci.example.test/pipelines/${id}`,
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
    artifacts: ["unit.json"],
  };
}

function childEnv(dir: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, AEGIS_DATA_DIR: dir, ...extra };
  delete env.BLOB_READ_WRITE_TOKEN;
  delete env.VERCEL;
  return env;
}

function runChild(script: string, env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, ["--import", "tsx", script], {
    cwd: root,
    env,
    encoding: "utf8",
  });
}

function memoryBlob(): { io: BlobIo; objects: Map<string, string> } {
  const objects = new Map<string, string>();
  const io: BlobIo = {
    async put(pathname, body, allowOverwrite) {
      if (!allowOverwrite && objects.has(pathname)) throw new Error("exists");
      objects.set(pathname, body);
    },
    async get(pathname) {
      return objects.get(pathname) ?? null;
    },
    async list(prefix) {
      return [...objects.keys()].filter((key) => key.startsWith(prefix));
    },
  };
  return { io, objects };
}

describe("durable store survives a new process", { concurrency: false }, () => {
  test("stored event is returned after the writer process is gone", async () => {
    const previousData = process.env.AEGIS_DATA_DIR;
    const previousSecret = process.env.AEGIS_PIPELINE_WEBHOOK_SECRET;
    const previousToken = process.env.BLOB_READ_WRITE_TOKEN;
    const previousVercel = process.env.VERCEL;
    const dir = mkdtempSync(path.join(os.tmpdir(), "aegis-survive-"));
    const secret = "process-boundary-secret";
    try {
      const child = runChild(path.join(support, "write-pipeline-event.ts"), childEnv(dir, {
        AEGIS_PIPELINE_WEBHOOK_SECRET: secret,
        EVENT_BODY: JSON.stringify(event()),
      }));
      assert.equal(child.status, 0, child.stderr);
      assert.notEqual(child.pid, process.pid);
      process.env.AEGIS_DATA_DIR = dir;
      process.env.AEGIS_PIPELINE_WEBHOOK_SECRET = secret;
      delete process.env.BLOB_READ_WRITE_TOKEN;
      delete process.env.VERCEL;
      const response = await GET();
      const payload = await response.json() as { evidence: { pipelineId: string; commitSha: string; schema: string } | null; storage: string };
      assert.equal(response.status, 200);
      assert.equal(payload.storage, "local");
      assert.equal(payload.evidence?.schema, "ccm.application-evidence.v1");
      assert.equal(payload.evidence?.pipelineId, "build-42");
      assert.equal(payload.evidence?.commitSha, COMMIT);
      assert.equal(JSON.stringify(payload).includes(secret), false);
    } finally {
      restore("AEGIS_DATA_DIR", previousData);
      restore("AEGIS_PIPELINE_WEBHOOK_SECRET", previousSecret);
      restore("BLOB_READ_WRITE_TOKEN", previousToken);
      restore("VERCEL", previousVercel);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("loaded package is returned after the writer process is gone", async () => {
    const previousData = process.env.AEGIS_DATA_DIR;
    const previousToken = process.env.BLOB_READ_WRITE_TOKEN;
    const previousVercel = process.env.VERCEL;
    const dir = mkdtempSync(path.join(os.tmpdir(), "aegis-package-survive-"));
    try {
      const child = runChild(path.join(support, "write-package.ts"), childEnv(dir));
      assert.equal(child.status, 0, child.stderr);
      const id = child.stdout.trim();
      assert.match(id, /^[a-f0-9]{32}$/);
      process.env.AEGIS_DATA_DIR = dir;
      delete process.env.BLOB_READ_WRITE_TOKEN;
      delete process.env.VERCEL;
      const response = await getPackage(new Request("http://127.0.0.1/api/package", {
        headers: { cookie: `aegis_sid=${id}` },
      }));
      const body = await response.json() as { packageState: { loaded: boolean; boundaryId: string | null; workspaceName: string | null } };
      assert.equal(response.status, 200);
      assert.equal(body.packageState.loaded, true);
      assert.equal(body.packageState.boundaryId, "bnd-gold-0001");
      assert.equal(body.packageState.workspaceName, "Gold fixture CSP boundary");
    } finally {
      restore("AEGIS_DATA_DIR", previousData);
      restore("BLOB_READ_WRITE_TOKEN", previousToken);
      restore("VERCEL", previousVercel);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("pipeline events and package snapshots share the blob store when AEGIS_DATA_DIR is unset", async () => {
    const previousData = process.env.AEGIS_DATA_DIR;
    const previousToken = process.env.BLOB_READ_WRITE_TOKEN;
    const previousVercel = process.env.VERCEL;
    const { io, objects } = memoryBlob();
    setBlobIoForTests(io);
    try {
      delete process.env.AEGIS_DATA_DIR;
      delete process.env.VERCEL;
      delete process.env.BLOB_READ_WRITE_TOKEN;
      const evidence = normalizePipelineEvent(event("build-blob"));
      await writeSelectedRelease({ receivedAt: "2026-10-03T08:00:00.000Z", evidence });
      const hash = releaseRecordKey(evidence);
      const releaseKey = `aegis/pipeline-releases/${hash}.json`;
      assert.equal(objects.has(releaseKey), true);
      assert.equal(existsSync(path.join(root, ".data", "pipeline-inbound", "history", `${hash}.json`)), false);
      assert.equal(existsSync(path.join(os.tmpdir(), "aegis-data", "pipeline-inbound", "history", `${hash}.json`)), false);
      const stored = await readSelectedRelease();
      assert.equal(stored?.evidence.pipelineId, "build-blob");

      const selected = await selectCatalog(new Request("http://127.0.0.1/api/catalogs/select", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ catalog: "fedramp-rev5" }),
      }));
      assert.equal(selected.status, 200);
      const id = /aegis_sid=([a-f0-9]{32})/.exec(selected.headers.getSetCookie().join("\n"))?.[1];
      assert.ok(id);
      const loaded = await loadFixture(new Request("http://127.0.0.1/api/fixtures/load", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: `aegis_sid=${id}` },
        body: JSON.stringify({ fixture: "gold" }),
      }));
      assert.equal(loaded.status, 200, await loaded.clone().text());
      const sessionKey = `aegis/sessions/${id}/state.json`;
      assert.equal(objects.has(sessionKey), true);
      assert.match(objects.get(sessionKey) ?? "", /bnd-gold-0001/);
      assert.equal(existsSync(path.join(root, ".data", "sessions", id, "state.json")), false);
      assert.equal(existsSync(path.join(os.tmpdir(), "aegis-data", "sessions", id, "state.json")), false);

      dropCachedSession(id);
      const again = await getPackage(new Request("http://127.0.0.1/api/package", {
        headers: { cookie: `aegis_sid=${id}` },
      }));
      const body = await again.json() as { packageState: { loaded: boolean; boundaryId: string | null } };
      assert.equal(body.packageState.loaded, true);
      assert.equal(body.packageState.boundaryId, "bnd-gold-0001");
    } finally {
      setBlobIoForTests(null);
      restore("AEGIS_DATA_DIR", previousData);
      restore("BLOB_READ_WRITE_TOKEN", previousToken);
      restore("VERCEL", previousVercel);
    }
  });

  test("vercel refuses the instance temp directory for a package snapshot", () => {
    const previousData = process.env.AEGIS_DATA_DIR;
    const previousToken = process.env.BLOB_READ_WRITE_TOKEN;
    const previousVercel = process.env.VERCEL;
    const id = "cd".repeat(16);
    try {
      setBlobIoForTests(null);
      process.env.VERCEL = "1";
      delete process.env.AEGIS_DATA_DIR;
      delete process.env.BLOB_READ_WRITE_TOKEN;
      const session = Session.create(id);
      assert.throws(() => session.commit({ ...emptyPersisted(), workspaceName: "must not land on tmp" }), /Durable storage is not configured/);
      assert.equal(existsSync(path.join(os.tmpdir(), "aegis-data", "sessions", id, "state.json")), false);
      assert.equal(session.state.workspaceName, null);
    } finally {
      restore("AEGIS_DATA_DIR", previousData);
      restore("BLOB_READ_WRITE_TOKEN", previousToken);
      restore("VERCEL", previousVercel);
    }
  });
});

function restore(name: "AEGIS_DATA_DIR" | "AEGIS_PIPELINE_WEBHOOK_SECRET" | "BLOB_READ_WRITE_TOKEN" | "VERCEL", value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
