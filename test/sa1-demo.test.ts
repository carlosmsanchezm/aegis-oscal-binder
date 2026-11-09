import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { findRepoRoot, getPackageState, ingestOscalPackage, saveControl, exportOscal, validateOscal } from "../lib/aegis";
import { sa1Document, SA1_EVIDENCE, SA1_BASELINES } from "../lib/aegis/sa1-demo";
import { withSession } from "../lib/server/http";
import { getSession, emptyPersisted } from "../lib/aegis";
import { sa1Request } from "../lib/server/sa1-router";
import { encodeSa1Snapshot, decodeSa1Snapshot, sa1SnapshotCookies } from "../lib/server/sa1-snapshot";
import { randomBytes } from "node:crypto";
import { dropCachedSession } from "../lib/aegis/store";
import { dataDir } from "../lib/aegis/paths";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Sa1Demo, Sa1Responsibility } from "../components/binder/Sa1Demo";
import { proposeArtifactMappings } from "../lib/aegis/artifact-mapping";
import { CCM_EXAMPLE } from "../lib/aegis/pipeline-evidence";
import { readPlanningState } from "../lib/server/planning-session";
import { generatedMapFixture } from "./support/map-fixtures";

test("internal planning presentation has neutral labels and concise ownership", () => {
  for (const loaded of [false, true]) {
    const markup = renderToStaticMarkup(createElement(Sa1Demo, { loaded, busy: false, onLoad() {}, onSelect() {}, onExport() {} }));
    assert.doesNotMatch(markup.replace(/<[^>]+>/g, ""), /SA1|Start.*demo|Reset.*demo/i);
    assert.match(markup, /Control planning/);
    assert.match(markup, /Demo planning data/);
    assert.match(markup, loaded ? /Reload example/ : /Load example/);
  }
  const ownership = renderToStaticMarkup(createElement(Sa1Responsibility, { id: "AU-2" }));
  assert.match(ownership, /Scope &amp; assumptions/);
  assert.match(ownership, /Security Operations selects logging events/);
  assert.equal(JSON.parse(sa1Document())["system-security-plan"].metadata.title, "Synthetic service boundary");
  assert.doesNotMatch(SA1_EVIDENCE.href, /sa1/i);
});

test("single demo route runs ingest, save, export, validate and artifact download with the same session", async () => {
  const jar = new Map<string, string>();
  let simulateCold = false;
  async function request(action: string, method = "GET", body?: unknown) {
    const sid = jar.get("aegis_sa1_sid");
    if (simulateCold && sid) {
      dropCachedSession(sid);
      const snapshotPath = path.join(dataDir(findRepoRoot()), "sessions", sid, "state.json");
      if (existsSync(snapshotPath)) unlinkSync(snapshotPath);
    }
    const response = await sa1Request(new Request(`http://localhost/api/demo/sa1/${action}`, {
      method, headers: { cookie: Array.from(jar).map(([k, v]) => `${k}=${v}`).join("; "), "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
    }), action.split("/"));
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(";")[0];
      const at = pair.indexOf("=");
      jar.set(pair.slice(0, at), pair.slice(at + 1));
    }
    assert.equal(response.status, 200, await response.clone().text());
    return response;
  }
  await request("package");
  await request("catalogs/select", "POST", { catalog: "fedramp-rev5" });
  const loaded = await (await request("oscal/ingest", "POST", { catalog: "fedramp-rev5", filename: "sa1-synthetic-ssp.json", document: sa1Document() })).json();
  const control = loaded.packageState.controls.find((c: { id: string }) => c.id === "AU-2");
  simulateCold = true;
  const saved = await (await request("controls/AU-2/save", "POST", { implementation: control.implementation, responsibleRoles: control.roleLabels.join("|"), responsibleRole: control.responsibleRole, evidence: SA1_EVIDENCE })).json();
  assert.equal(saved.packageState.gate.status, "PASS");
  await request("oscal/export", "POST");
  const validated = await (await request("oscal/validate", "POST", { scenario: "current" })).json();
  assert.equal(validated.packageState.pipeline.validator.status, "GREEN");
  assert.match(await (await request("artifacts/oscal")).text(), /Synthetic event-logging standard/);
  const read = await (await request("package")).json();
  assert.equal(read.packageState.gate.status, "PASS");
  assert.equal(read.packageState.pipeline.validator.status, "GREEN");
});

test("SA1 header isolates the demo from the regular cookie and GET downloads use the demo cookie", async () => {
  const regular = await withSession(new Request("http://localhost/api/package"), () => {
    getSession().commit({ ...emptyPersisted(), workspaceName: "regular sentinel" });
    return Response.json({ ok: true });
  });
  const regularCookie = regular.headers.get("set-cookie")!.split(";")[0];
  const demo = await withSession(new Request("http://localhost/api/package", { headers: { cookie: regularCookie, "x-aegis-workspace": "sa1-demo" } }), () => {
    assert.equal(getSession().state.workspaceName, null);
    getSession().commit({ ...emptyPersisted(), workspaceName: "demo sentinel" });
    return Response.json({ ok: true });
  });
  const demoCookie = demo.headers.getSetCookie().find((c) => c.startsWith("aegis_sa1_sid="))!.split(";")[0];
  assert.match(demoCookie, /^aegis_sa1_sid=/);
  const cookies = `${regularCookie}; ${demoCookie}`;
  await withSession(new Request("http://localhost/api/package", { headers: { cookie: cookies } }), () => {
    assert.equal(getSession().state.workspaceName, "regular sentinel");
    return Response.json({ ok: true });
  });
  await withSession(new Request("http://localhost/api/artifacts/oscal?workspace=sa1-demo", { headers: { cookie: cookies } }), () => {
    assert.equal(getSession().state.workspaceName, "demo sentinel");
    return Response.json({ ok: true });
  });
});

test("encrypted SA1 snapshot rejects tampering, another session, and expiry", () => {
  const secret = randomBytes(32);
  const state = { ...emptyPersisted(), workspaceName: "synthetic snapshot" };
  const encoded = encodeSa1Snapshot(state, "session-a", secret, 1000);
  const cookies = sa1SnapshotCookies(encoded, true).map((c) => c.split(";")[0]).join("; ");
  assert.equal(decodeSa1Snapshot(cookies, "session-a", secret, 2000)?.workspaceName, state.workspaceName);
  assert.equal(decodeSa1Snapshot(cookies, "session-b", secret, 2000), null);
  assert.equal(decodeSa1Snapshot(cookies, "session-a", secret, 1000 + 86_400_000), null);
  assert.equal(decodeSa1Snapshot(cookies.replace(encoded.slice(0, 10), "AAAAAAAAAA"), "session-a", secret, 2000), null);
});

test("mapping acceptance survives reload through the encrypted planning snapshot when durable storage is unavailable", async () => {
  const previous = {
    data: process.env.AEGIS_DATA_DIR,
    blob: process.env.BLOB_READ_WRITE_TOKEN,
    vercel: process.env.VERCEL,
    key: process.env.AEGIS_DEMO_COOKIE_KEY,
  };
  const jar = new Map<string, string>();
  const cookieHeader = () => [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
  async function request(action: string, method = "GET", body?: unknown) {
    const response = await sa1Request(new Request(`http://localhost/api/demo/sa1/${action}`, {
      method,
      headers: {
        cookie: cookieHeader(),
        "content-type": "application/json",
        "x-aegis-workspace": "sa1-demo",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }), action.split("/"));
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(";")[0], at = pair.indexOf("=");
      jar.set(pair.slice(0, at), pair.slice(at + 1));
    }
    return response;
  }
  try {
    delete process.env.AEGIS_DATA_DIR;
    delete process.env.BLOB_READ_WRITE_TOKEN;
    process.env.VERCEL = "1";
    process.env.AEGIS_DEMO_COOKIE_KEY = "01".repeat(32);

    assert.equal((await request("package")).status, 200);
    const { moderateControls } = await import("../lib/aegis/moderate-baseline");
    const proposal = proposeArtifactMappings(CCM_EXAMPLE, moderateControls().map(c => c.id)).find(p => p.artifact === "configuration.raw.json")!;
    const proposalKey = proposal.key;
    const accepted = await request("pipeline/mappings", "POST", { proposalKey, profile: proposal.profile, status: "accepted" });
    assert.equal(accepted.status, 200, await accepted.clone().text());

    const restored = await readPlanningState(cookieHeader());
    assert.equal(restored.pipelineMappingDecisions?.find(item => item.proposalKey === proposalKey)?.status, "accepted");
    assert.doesNotThrow(() => getPackageState(restored, { root: findRepoRoot() }));

    const mappings = await request("pipeline/mappings");
    assert.equal(mappings.status, 200, await mappings.clone().text());
    const body = await mappings.json() as { decisions: Array<{ proposalKey: string; status: string }> };
    assert.equal(body.decisions.find(item => item.proposalKey === proposalKey)?.status, "accepted");
  } finally {
    if (previous.data == null) delete process.env.AEGIS_DATA_DIR; else process.env.AEGIS_DATA_DIR = previous.data;
    if (previous.blob == null) delete process.env.BLOB_READ_WRITE_TOKEN; else process.env.BLOB_READ_WRITE_TOKEN = previous.blob;
    if (previous.vercel == null) delete process.env.VERCEL; else process.env.VERCEL = previous.vercel;
    if (previous.key == null) delete process.env.AEGIS_DEMO_COOKIE_KEY; else process.env.AEGIS_DEMO_COOKIE_KEY = previous.key;
  }
});

test("SA1 synthetic package closes one documentation gap through the real OSCAL workflow", () => {
  const root = findRepoRoot();
  const ctx = { root, outDir: mkdtempSync(path.join(tmpdir(), "sa1-demo-")), now: () => new Date("2026-09-28T18:00:00Z") };
  const state = ingestOscalPackage({ text: sa1Document(), filename: "sa1-synthetic-ssp.json", catalogId: "fedramp-rev5" }, ctx);
  const pkg = getPackageState(state, ctx);
  assert.equal(pkg.inScopeCount, 12);
  assert.equal(pkg.gate.incomplete, 1);
  const logging = pkg.controls.find((c) => c.id === "AU-2")!;
  assert.deepEqual(logging.missing, ["evidence"]);
  assert.ok(logging.roleLabels.some((label) => /Security Officer|ISSO/.test(label)));
  const saved = saveControl(state, "AU-2", { implementation: logging.implementation, responsibleRole: logging.responsibleRole, evidence: SA1_EVIDENCE }, ctx);
  assert.equal(getPackageState(saved, ctx).gate.status, "PASS");
  const exported = exportOscal(saved, ctx);
  const validated = validateOscal(exported.state, ctx, "current");
  assert.equal(validated.packageState.pipeline.validator.status, "GREEN");
  const original = JSON.parse(readFileSync(path.join(root, "public/samples/sample-oscal-ssp-rev5.json"), "utf8"));
  assert.equal(original["system-security-plan"].metadata.title, "Upload sample CSP");
  assert.equal(SA1_BASELINES.find((r) => r.id === "AC-6")?.low, false);
});


test("planning with an existing session renders when preview storage is unset", async () => {
  const { readPlanningState } = await import("../lib/server/planning-session");
  const before = {VERCEL:process.env.VERCEL,AEGIS_DATA_DIR:process.env.AEGIS_DATA_DIR,BLOB_READ_WRITE_TOKEN:process.env.BLOB_READ_WRITE_TOKEN};
  try {
    process.env.VERCEL="1"; delete process.env.AEGIS_DATA_DIR; delete process.env.BLOB_READ_WRITE_TOKEN;
    const state = await readPlanningState(`aegis_sa1_sid=${"ab".repeat(16)}`);
    assert.equal(state.loaded,false);
    assert.doesNotThrow(()=>getPackageState(state,{root:findRepoRoot()}));
  } finally {
    for (const [key,value] of Object.entries(before)) { if(value == null) delete process.env[key]; else process.env[key]=value; }
  }
});

test("planning cookie omits the uploaded SSP so generated layout fixtures still fit", () => {
  const root = findRepoRoot();
  const ctx = { root, now: () => new Date("2026-10-15T00:00:00Z") };
  const secret = randomBytes(32);
  for (const size of ["tiny", "medium", "huge", "random"] as const) {
    const fixture = generatedMapFixture(5721, size);
    const state = ingestOscalPackage({
      text: JSON.stringify(fixture.document),
      filename: "synthetic-ssp.json",
      catalogId: "fedramp-rev5",
    }, ctx);
    assert.ok(state.sourceSsp);
    assert.ok(state.importBaseline && state.importBaseline.length > 0);
    const encoded = encodeSa1Snapshot(state, "layout-session", secret, 1_000);
    assert.ok(encoded.length <= 9_000, `${size} cookie is ${encoded.length}`);
    const restored = decodeSa1Snapshot(
      sa1SnapshotCookies(encoded, false).map((cookie) => cookie.split(";")[0]).join("; "),
      "layout-session",
      secret,
      2_000,
    );
    assert.ok(restored);
    assert.equal(restored.sourceSsp, undefined);
    assert.equal(restored.importBaseline, undefined);
    assert.equal(restored.controls.length, state.controls.length);
    assert.deepEqual(restored.controls.map((control) => control.id), state.controls.map((control) => control.id));
  }
});

test("planning cookie omits optional map metadata without changing durable controls or owners", () => {
  const state = ingestOscalPackage({
    text: sa1Document(), filename: "synthetic-ssp.json", catalogId: "fedramp-rev5",
  }, { root: findRepoRoot(), now: () => new Date("2026-10-15T00:00:00Z") });
  assert.ok(state.controls.some(control => control.implementedBy?.length));
  state.controls[0].providerCoverage = [{
    provider: { id: "synthetic-provider", title: "Synthetic provider" }, coverage: "part",
  }];
  const before = structuredClone(state);
  const expectedControls = structuredClone(state.controls);
  for (const control of expectedControls) {
    delete control.implementedBy;
    delete control.providerCoverage;
  }
  const secret = randomBytes(32);
  const encoded = encodeSa1Snapshot(state, "metadata-session", secret, 1_000);
  const restored = decodeSa1Snapshot(
    sa1SnapshotCookies(encoded, false).map(cookie => cookie.split(";")[0]).join("; "),
    "metadata-session", secret, 2_000,
  );
  assert.ok(restored);
  assert.deepEqual(restored.controls, expectedControls);
  assert.deepEqual(restored.roles, state.roles);
  assert.deepEqual(state, before, "encoding must not strip metadata from durable state");
});
