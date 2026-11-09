import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { GET as reference } from "../app/api/builder/reference/route";
import { POST as create, GET as summary } from "../app/api/builder/route";
import { POST as upload } from "../app/api/builder/connections/[id]/imports/route";
import { DELETE as revoke } from "../app/api/builder/connections/[id]/route";
import { GET as download } from "../app/api/builder/evidence/[id]/route";
import { sha256 } from "../lib/server/builder-store";

test("reference endpoint preserves actual capture bytes, dates and authorization responses", async () => {
  const response = await reference(new Request("http://localhost/api/builder/reference"));
  assert.equal(response.status, 200);
  const capture = await response.json();
  assert.deepEqual(capture.events.slice(0,2).map((e: { id: string }) => e.id), ["bf083e020e937ee482a3f70863bc6cc31a22f63de4ee9f42e9a40d290069af3a", "7c78c4bb75b2749aecd63d09c90c886ea2cbaaca7a4c19c0a92154c38b97406a"]);
  for (const [i, event] of capture.events.slice(0,2).entries()) {
    assert.equal(sha256(event.rawEvent), event.id);
    const parsed = JSON.parse(event.rawEvent);
    assert.equal(parsed.run.observedAt, i ? "2026-10-06T02:54:20.862Z" : "2026-10-06T02:54:20.612Z");
    const artifact = parsed.artifacts.find((a: { name: string }) => a.name === "authorization-review.json");
    const review = JSON.parse(Buffer.from(artifact.contentBase64, "base64").toString());
    assert.equal(review.status.allowed, i === 0);
  }
  const file = await reference(new Request("http://localhost/api/builder/reference?stage=after"));
  assert.match(file.headers.get("content-disposition")!, /attachment/);
  assert.equal(await file.text(), capture.events[1].rawEvent);
});

test("owner imports need no CI token, persist unchanged captures, reject outsiders and respect revocation", async () => {
  const previous = process.env.AEGIS_DATA_DIR, dir = mkdtempSync(path.join(os.tmpdir(), "binder-owner-import-"));
  process.env.AEGIS_DATA_DIR = dir;
  try {
    const created = await create(new Request("http://localhost/api/builder", { method: "POST", body: JSON.stringify({ name: "Reviewer reference" }) }));
    const owner = created.headers.get("set-cookie")!.split(";")[0], body = await created.json();
    const id = body.connection.id, context = { params: Promise.resolve({ id }) };
    const capture = await (await reference(new Request("http://localhost/api/builder/reference"))).json();
    const req = (raw: string, headers: Record<string, string> = { cookie: owner }) => new Request(`http://localhost/api/builder/connections/${id}/imports`, { method: "POST", headers, body: raw });
    assert.equal((await upload(req(capture.events[0].rawEvent, {}), context)).status, 404);
    assert.equal((await upload(req(capture.events[0].rawEvent, { authorization: `Bearer ${body.token}` }), context)).status, 404);
    assert.equal((await upload(req(capture.events[0].rawEvent, { cookie: owner, origin: "https://foreign.test" }), context)).status, 403);
    assert.equal((await upload(req("{private-invalid-content"), context)).status, 400);
    assert.equal((await upload(req("x".repeat(512001)), context)).status, 413);
    for (const event of capture.events) {
      const response = await upload(req(event.rawEvent), context);
      assert.equal(response.status, 201);
      assert.equal((await response.json()).evidenceId, event.id);
    }
    const repeated = await upload(req(capture.events[0].rawEvent), context);
    assert.equal(repeated.status, 201);
    const data = await (await summary(new Request("http://localhost/api/builder", { headers: { cookie: owner } }))).json();
    assert.equal(data.connections[0].history.length, capture.events.length);
    assert.ok(data.connections[0].history.some((h: any)=>h.collectedArtifacts?.length));
    assert.equal(data.connections[0].history[0].authentication, "browser-owner");
    const bundle = await download(new Request(`http://localhost/api/builder/evidence/${capture.events[1].id}?connection=${id}`, { headers: { cookie: owner } }), { params: Promise.resolve({ id: capture.events[1].id }) });
    assert.equal((await bundle.json()).rawEvent, capture.events[1].rawEvent);
    assert.equal((await summary(new Request("http://localhost/api/builder"))).status, 200);
    assert.equal((await (await summary(new Request("http://localhost/api/builder"))).json()).connections.length, 0);
    await revoke(new Request(`http://localhost/api/builder/connections/${id}`, { method: "DELETE", headers: { cookie: owner } }), context);
    assert.equal((await upload(req(capture.events[1].rawEvent), context)).status, 409);
  } finally {
    if (previous == null) delete process.env.AEGIS_DATA_DIR; else process.env.AEGIS_DATA_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
