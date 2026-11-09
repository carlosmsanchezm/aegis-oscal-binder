import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { GET, POST } from "../app/api/builder/route";
import { POST as receive } from "../app/api/builder/connections/[id]/events/route";
import { DELETE as revoke } from "../app/api/builder/connections/[id]/route";
import { GET as download } from "../app/api/builder/evidence/[id]/route";
import { BUILDER_BUNDLE_SCHEMA, checkState, latestChecks, parseEvidenceEvent, type EvidenceEvent } from "../lib/builder/evidence";
import { authenticatesConnection, createConnection, listBundles, listConnections, readConnection, retainEvent, sha256, verifyBundle } from "../lib/server/builder-store";
import { setBlobIoForTests } from "../lib/durable";

const exec = promisify(execFile);
function event(verdict: "pass" | "fail" | "unknown" = "fail", revision = "revision-1", observedAt = new Date().toISOString()): EvidenceEvent {
  const content = Buffer.from(JSON.stringify({ measured: verdict, revision }));
  return {
    schema: "aegis.evidence-event.v1",
    run: { id: `run-${revision}`, producer: "test collector", observedAt },
    subject: { kind: "identity", id: "service-role", revision },
    checks: [{ id: "scoped-permission", version: "1", description: "A precise permission observation", requirement: { framework: "Pilot policy", reference: "Least privilege", objective: "The role has no unused write permission." }, verdict, artifacts: ["identity.json"], validUntil: new Date(Date.parse(observedAt) + 3600_000).toISOString() }],
    artifacts: [{ name: "identity.json", mediaType: "application/json", contentBase64: content.toString("base64"), sha256: sha256(content) }],
    limitations: ["Identity is declared; this observation is not a full-control assessment."],
  };
}
async function directory(run: (dir: string) => Promise<void>) {
  const previous = process.env.AEGIS_DATA_DIR, dir = mkdtempSync(path.join(os.tmpdir(), "binder-builder-"));
  process.env.AEGIS_DATA_DIR = dir;
  try { await run(dir); }
  finally { if (previous == null) delete process.env.AEGIS_DATA_DIR; else process.env.AEGIS_DATA_DIR = previous; rmSync(dir, { recursive: true, force: true }); }
}
function bundle(e = event()) { return verifyBundle({ schema: BUILDER_BUNDLE_SCHEMA, id: sha256(JSON.stringify(e)), connectionId: "11111111-1111-4111-8111-111111111111", receivedAt: e.run.observedAt, rawEvent: JSON.stringify(e), event: e, integrity: "verified", authentication: "connection-token" }); }
const context = (id: string) => ({ params: Promise.resolve({ id }) });

test("generic evidence supports identity/process subjects without invented deployment fields", () => {
  for (const kind of ["identity", "process", "code", "infrastructure", "network"] as const) {
    const parsed = parseEvidenceEvent({ ...event(), subject: { ...event().subject, kind } });
    assert.equal(parsed.subject.kind, kind);
    assert.equal("image" in parsed, false);
    assert.equal("runtime" in parsed, false);
    assert.equal("approval" in parsed, false);
  }
  assert.throws(() => parseEvidenceEvent({ ...event(), artifacts: [{ ...event().artifacts[0], name: "../secret" }] }), /artifact name/);
  assert.throws(() => parseEvidenceEvent({ ...event(), checks: [{ ...event().checks[0], artifacts: ["absent.json"] }] }), /inventory/);
  assert.throws(() => parseEvidenceEvent({ ...event(), checks: [event().checks[0], event().checks[0]] }), /Duplicate/);
  assert.throws(() => parseEvidenceEvent({ ...event(), run: { ...event().run, observedAt: "2026-02-30T00:00:00Z" } }), /observation/);
});

test("retained bytes, artifact digests and normalized manifest must agree", () => {
  const good = bundle();
  assert.equal(verifyBundle(good, good.id).integrity, "verified");
  assert.throws(() => verifyBundle({ ...good, rawEvent: good.rawEvent + " " }, good.id), /digest mismatch/);
  assert.throws(() => verifyBundle({ ...good, event: { ...good.event, subject: { ...good.event.subject, revision: "other" } } }), /manifest mismatch/);
  const bad = event(); bad.artifacts[0].contentBase64 = Buffer.from("tampered").toString("base64");
  assert.throws(() => bundle(bad), /Artifact digest mismatch/);
});

test("freshness and changed subject/spec prevent old passes from appearing current", () => {
  const now = Date.now(), first = event("pass", "r1", new Date(now - 5000).toISOString());
  assert.equal(checkState(first, first.checks[0], now), "pass");
  assert.equal(checkState(first, first.checks[0], now + 3600_000), "stale");
  const next = event("unknown", "r2", new Date(now - 1000).toISOString()); next.checks[0].id = "new-check";
  const rows = latestChecks([bundle(first), bundle(next)], now);
  assert.equal(rows.find(r => r.check.id === "scoped-permission")?.state, "outdated");
  const changed = event("fail", "r1", new Date(now - 500).toISOString()); changed.checks[0].version = "2";
  assert.equal(latestChecks([bundle(first), bundle(changed)], now).find(r => r.check.version === "1")?.state, "outdated");
  const future = event("pass", "r3", new Date(now + 600_000).toISOString());
  assert.equal(latestChecks([bundle(first), bundle(future)], now)[0].bundle.event.subject.revision, "r1");
});

test("retests compare exact objective/spec/subject and keep the prior failure", () => {
  const now = Date.now(), failed = bundle(event("fail", "r1", new Date(now - 2000).toISOString()));
  const passed = bundle(event("pass", "r2", new Date(now - 1000).toISOString()));
  const rows = latestChecks([failed, passed], now);
  assert.equal(rows.length, 1); assert.equal(rows[0].state, "pass"); assert.equal(rows[0].previous?.id, failed.id);
  assert.equal("closure" in rows[0], false);
  const changed = event("pass", "r2", new Date(now - 1000).toISOString()); changed.checks[0].requirement.objective = "A different criterion";
  assert.equal(latestChecks([failed, bundle(changed)], now).find(r => r.check.requirement.objective === changed.checks[0].requirement.objective)?.previous, undefined);
});

test("immutable receipt replay and owner-indexed history work in directory storage", async () => directory(async () => {
  const a = await createConnection("System A"), b = await createConnection("System B");
  assert.equal((await listConnections(null)).length, 0);
  assert.deepEqual((await listConnections(a.owner)).map(c => c.name), ["System A"]);
  const raw = JSON.stringify(event()), original = await retainEvent(a.connection.id, raw), duplicate = await retainEvent(a.connection.id, raw);
  assert.equal(original.receivedAt, duplicate.receivedAt);
  assert.equal((await listBundles(a.connection.id)).length, 1);
  assert.equal((await listBundles(b.connection.id)).length, 0);
  assert.equal(authenticatesConnection(a.connection, b.token), false);
}));

test("same evidence persistence works in Blob and storage failure never becomes an empty view", async () => {
  const dir = process.env.AEGIS_DATA_DIR; delete process.env.AEGIS_DATA_DIR;
  const store = new Map<string, string>();
  setBlobIoForTests({ async get(k) { return store.get(k) ?? null; }, async list(p) { return [...store.keys()].filter(k => k.startsWith(p)); }, async put(k, v, overwrite) { if (!overwrite && store.has(k)) throw new Error("exists"); store.set(k, v); } });
  try {
    const c = await createConnection("Blob system");
    const raw = JSON.stringify(event());
    await Promise.all([retainEvent(c.connection.id, raw), retainEvent(c.connection.id, raw)]);
    assert.equal((await listBundles(c.connection.id)).length, 1);
    const all = [...store.values()].join(""); assert.equal(all.includes(c.token), false); assert.equal(all.includes(c.owner), false);
    setBlobIoForTests({ async get() { throw new Error("store down"); }, async list() { throw new Error("store down"); }, async put() { throw new Error("store down"); } });
    const response = await GET(new Request("http://localhost/api/builder", { headers: { cookie: `aegis_builder_owner=${c.owner}` } }));
    assert.equal(response.status, 503); assert.equal((await response.json()).ok, false);
  } finally { setBlobIoForTests(null); if (dir != null) process.env.AEGIS_DATA_DIR = dir; }
});

test("routes isolate readers, reject bad uploads and revoke only the owning connection", async () => directory(async () => {
  const create = await POST(new Request("http://localhost/api/builder", { method: "POST", headers: { origin: "http://localhost" }, body: JSON.stringify({ name: "API system" }) }));
  assert.equal(create.status, 201);
  const cookie = create.headers.get("set-cookie")!.split(";")[0], body = await create.json();
  const id = body.connection.id, raw = JSON.stringify(event());
  const send = (token = body.token, payload = raw) => receive(new Request(`http://localhost/api/builder/connections/${id}/events`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: payload }), context(id));
  assert.equal((await send("00".repeat(32))).status, 401);
  const invalid = await send(body.token, "{secret-not-to-echo"); assert.equal(invalid.status, 400); assert.equal(JSON.stringify(await invalid.json()).includes("secret-not-to-echo"), false);
  assert.equal((await send(body.token, "x".repeat(512001))).status, 413);
  assert.equal((await send()).status, 201);
  const summary = await (await GET(new Request("http://localhost/api/builder", { headers: { cookie } }))).json();
  assert.equal(summary.connections[0].history.length, 1); assert.equal(JSON.stringify(summary).includes(body.token), false); assert.equal(JSON.stringify(summary).includes("contentBase64"), false);
  assert.equal((await (await GET(new Request("http://localhost/api/builder"))).json()).connections.length, 0);
  const evidenceId = summary.connections[0].history[0].id;
  const target = `http://localhost/api/builder/evidence/${evidenceId}?connection=${id}`;
  assert.equal((await download(new Request(target, { headers: { authorization: `Bearer ${body.token}` } }), context(evidenceId))).status, 404);
  assert.equal((await download(new Request(target, { headers: { cookie } }), context(evidenceId))).status, 200);
  const artifact = await download(new Request(`${target}&artifact=identity.json`, { headers: { cookie } }), context(evidenceId));
  assert.equal(artifact.status, 200);
  assert.match(artifact.headers.get("content-disposition")!, /attachment/);
  assert.deepEqual(Buffer.from(await artifact.arrayBuffer()), Buffer.from(event().artifacts[0].contentBase64, "base64"));
  assert.equal((await download(new Request(`${target}&artifact=identity.json`), context(evidenceId))).status, 404);
  assert.equal((await download(new Request(`${target}&artifact=absent.json`, { headers: { cookie } }), context(evidenceId))).status, 404);

  assert.equal((await revoke(new Request(`http://localhost/api/builder/connections/${id}`, { method: "DELETE" }), context(id))).status, 404);
  assert.equal((await revoke(new Request(`http://localhost/api/builder/connections/${id}`, { method: "DELETE", headers: { cookie } }), context(id))).status, 200);
  assert.equal((await send()).status, 401);
  assert.ok((await readConnection(id))?.revokedAt);
  assert.equal((await download(new Request(target, { headers: { cookie } }), context(evidenceId))).status, 200);
}));

test("cross-site connection creation is blocked and unconfigured durable storage fails closed", async () => {
  const cross = await POST(new Request("https://binder.test/api/builder", { method: "POST", headers: { origin: "https://attacker.test" }, body: '{"name":"other"}' }));
  assert.equal(cross.status, 403);
  const saved = { data: process.env.AEGIS_DATA_DIR, vercel: process.env.VERCEL, blob: process.env.BLOB_READ_WRITE_TOKEN };
  process.env.VERCEL = "1"; delete process.env.AEGIS_DATA_DIR; delete process.env.BLOB_READ_WRITE_TOKEN;
  try {
    const create = await POST(new Request("https://binder.test/api/builder", { method: "POST", body: '{"name":"Unavailable"}' }));
    assert.equal(create.status, 503);
  } finally {
    for (const [k, v] of [["AEGIS_DATA_DIR", saved.data], ["VERCEL", saved.vercel], ["BLOB_READ_WRITE_TOKEN", saved.blob]]) { if (v == null) delete process.env[k!]; else process.env[k!] = v; }
  }
});

test("real collector fails an ineffective restriction, passes the correction, and reports outages unknown", async () => directory(async dir => {
  let restricted = false;
  const server = createServer((req, res) => { res.writeHead(req.url === "/prohibited" && restricted ? 403 : 200); res.end(); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const config = { subject: { id: "local-access-service" }, requirement: { framework: "Pilot policy", reference: "access", objective: "Required endpoint succeeds; prohibited endpoint rejects this caller." }, probes: { allowed: { url: `http://127.0.0.1:${port}/required`, expectedStatus: 200 }, denied: { url: `http://127.0.0.1:${port}/prohibited`, expectedStatus: 403 } }, freshnessSeconds: 3600 };
  const file = path.join(dir, "config.json"), output = path.join(dir, "event.json"); writeFileSync(file, JSON.stringify(config));
  const cmd = ["public/builder-evidence.mjs", "check-access", "--config", file, "--revision", "r1", "--run-id", "run1", "--out", output];
  try {
    await assert.rejects(exec(process.execPath, cmd), e => (e as { code: number }).code === 2);
    const failed = parseEvidenceEvent(JSON.parse(readFileSync(output, "utf8"))); assert.equal(failed.checks[0].verdict, "fail");
    const tampered = structuredClone(failed); tampered.checks[0].verdict = "pass";
    assert.throws(() => bundle(tampered), /contradicts/);
    restricted = true; cmd[cmd.indexOf("r1")] = "r2"; await exec(process.execPath, cmd);
    const passed = parseEvidenceEvent(JSON.parse(readFileSync(output, "utf8"))); assert.equal(passed.checks[0].verdict, "pass");
    const c = await createConnection("Measured service");
    await retainEvent(c.connection.id, JSON.stringify(failed)); const receipt = await retainEvent(c.connection.id, JSON.stringify(passed));
    assert.equal(latestChecks(await listBundles(c.connection.id))[0].previous?.event.checks[0].verdict, "fail");
    const saved = path.join(dir, "bundle.json"); writeFileSync(saved, JSON.stringify(receipt));
    const result = await exec(process.execPath, ["public/builder-evidence.mjs", "verify", "--file", saved, "--expected-id", receipt.id]); assert.match(result.stdout, /verified/);
    await assert.rejects(exec(process.execPath, ["public/builder-evidence.mjs", "verify", "--file", saved, "--expected-id", "00".repeat(32)]));
    const changed = { ...receipt, rawEvent: receipt.rawEvent + " " }; writeFileSync(saved, JSON.stringify(changed));
    await assert.rejects(exec(process.execPath, ["public/builder-evidence.mjs", "verify", "--file", saved]));
    await new Promise<void>(resolve => server.close(() => resolve()));
    await assert.rejects(exec(process.execPath, cmd), e => (e as { code: number }).code === 2);
    const unavailable = parseEvidenceEvent(JSON.parse(readFileSync(output, "utf8"))); assert.equal(unavailable.checks[0].verdict, "unknown");
  } finally { if (server.listening) await new Promise<void>(resolve => server.close(() => resolve())); }
}));
