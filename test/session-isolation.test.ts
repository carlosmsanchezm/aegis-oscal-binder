import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { POST as selectCatalog } from "../app/api/catalogs/select/route";
import { GET as getOscal } from "../app/api/artifacts/oscal/route";
import { POST as loadFixture } from "../app/api/fixtures/load/route";
import { POST as ingestOscal } from "../app/api/oscal/ingest/route";
import { POST as exportOscalRoute } from "../app/api/oscal/export/route";
import { GET as getPackage } from "../app/api/package/route";
import { POST as resetPackage } from "../app/api/package/reset/route";
import { POST as resetWorkspaceRoute } from "../app/api/workspace/reset/route";
import { findRepoRoot } from "../lib/aegis";
import { dropCachedSession } from "../lib/aegis/store";

const root = findRepoRoot();
const rev5 = readFileSync(path.join(root, "fixtures", "upload", "ssp-rev5.json"), "utf8");

type PackageBody = {
  ok: boolean;
  packageState?: {
    loaded: boolean;
    workspaceName: string | null;
    boundaryId: string | null;
    catalogPin: string | null;
    catalog: { id: string | null; bound: boolean };
  };
  error?: { code: string; message: string };
};

function sessionId(response: Response): string | null {
  const cookies = response.headers.getSetCookie();
  for (const cookie of cookies) {
    const match = /^aegis_sid=([a-f0-9]{32})\b/.exec(cookie);
    if (match?.[1]) return match[1];
  }
  return null;
}

function cookieHeader(id?: string): Headers {
  const headers = new Headers();
  if (id) headers.set("cookie", `aegis_sid=${id}`);
  return headers;
}

async function postJson(route: (req: Request) => Promise<Response> | Response, url: string, body: unknown, id?: string): Promise<Response> {
  const headers = cookieHeader(id);
  headers.set("content-type", "application/json");
  return route(new Request(url, { method: "POST", headers, body: JSON.stringify(body) }));
}

async function readPackage(id?: string): Promise<{ response: Response; body: PackageBody }> {
  const response = await getPackage(new Request("http://127.0.0.1/api/package", { headers: cookieHeader(id) }));
  const body = (await response.json()) as PackageBody;
  return { response, body };
}

async function choose(catalog: string, id?: string): Promise<{ response: Response; body: PackageBody; id: string }> {
  const response = await postJson(selectCatalog, "http://127.0.0.1/api/catalogs/select", { catalog }, id);
  const body = (await response.json()) as PackageBody;
  const next = id ?? sessionId(response);
  assert.ok(next, "catalog select did not establish a session cookie");
  return { response, body, id: next };
}

test("two sessions stay isolated and a cookieless read stays empty", async () => {
  const first = await choose("fedramp-rev5");
  assert.equal(first.response.status, 200);
  assert.equal(first.body.packageState?.loaded, false);
  const cookie = first.response.headers.getSetCookie().join("\n");
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.doesNotMatch(cookie, /Secure/);
  assert.match(cookie, /Max-Age=7200/);

  const uploaded = await postJson(
    ingestOscal,
    "http://127.0.0.1/api/oscal/ingest",
    { document: rev5, filename: "ssp-rev5.json", catalog: "fedramp-rev5" },
    first.id,
  );
  const uploadedBody = (await uploaded.json()) as PackageBody;
  assert.equal(uploaded.status, 200, JSON.stringify(uploadedBody));
  assert.equal(uploadedBody.packageState?.loaded, true);
  assert.equal(uploadedBody.packageState?.workspaceName, "Upload sample CSP");
  assert.equal(uploadedBody.packageState?.boundaryId, "bnd-upload-rev5");

  const locked = await choose("fedramp-20x", first.id);
  assert.equal(locked.response.status, 400);
  assert.equal(locked.body.error?.code, "READ_ONLY");

  const anon = await readPackage();
  assert.equal(anon.response.status, 200);
  assert.equal(anon.body.packageState?.loaded, false);
  assert.equal(anon.body.packageState?.workspaceName, null);
  assert.equal(anon.body.packageState?.boundaryId, null);
  assert.equal(anon.body.packageState?.catalog.id, null);
  assert.match(anon.response.headers.get("cache-control") ?? "", /no-store/);
  const anonId = sessionId(anon.response);
  assert.ok(anonId);
  assert.notEqual(anonId, first.id);

  const anonAgain = await readPackage();
  assert.equal(anonAgain.body.packageState?.loaded, false);
  assert.notEqual(sessionId(anonAgain.response), first.id);

  const second = await choose("fedramp-rev5");
  assert.notEqual(second.id, first.id);
  assert.equal(second.body.packageState?.loaded, false);
  const gold = await postJson(loadFixture, "http://127.0.0.1/api/fixtures/load", { fixture: "gold" }, second.id);
  const goldBody = (await gold.json()) as PackageBody;
  assert.equal(gold.status, 200, JSON.stringify(goldBody));
  assert.equal(goldBody.packageState?.workspaceName, "Gold fixture CSP boundary");
  assert.equal(goldBody.packageState?.boundaryId, "bnd-gold-0001");

  const mine = await readPackage(first.id);
  assert.equal(mine.body.packageState?.loaded, true);
  assert.equal(mine.body.packageState?.boundaryId, "bnd-upload-rev5");
  const theirs = await readPackage(second.id);
  assert.equal(theirs.body.packageState?.loaded, true);
  assert.equal(theirs.body.packageState?.boundaryId, "bnd-gold-0001");

  const stranger = await readPackage("ab".repeat(16));
  assert.equal(stranger.body.packageState?.loaded, false);
  assert.equal(stranger.body.packageState?.workspaceName, null);
});

test("reset clears only the caller session", async () => {
  const owner = await choose("fedramp-rev5");
  const uploaded = await postJson(
    ingestOscal,
    "http://127.0.0.1/api/oscal/ingest",
    { document: rev5, filename: "ssp-rev5.json", catalog: "fedramp-rev5" },
    owner.id,
  );
  assert.equal(uploaded.status, 200);

  const other = await choose("fedramp-rev5");
  const gold = await postJson(loadFixture, "http://127.0.0.1/api/fixtures/load", { fixture: "gold" }, other.id);
  assert.equal(gold.status, 200);

  const cleared = await resetPackage(new Request("http://127.0.0.1/api/package/reset", {
    method: "POST",
    headers: cookieHeader(owner.id),
  }));
  const clearedBody = (await cleared.json()) as PackageBody;
  assert.equal(cleared.status, 200);
  assert.equal(clearedBody.packageState?.loaded, false);
  assert.equal(clearedBody.packageState?.workspaceName, null);
  assert.equal(clearedBody.packageState?.catalog.id, "fedramp-rev5");
  assert.equal(clearedBody.packageState?.catalog.bound, false);
  assert.equal(clearedBody.packageState?.catalogPin, "fedramp-rev5-subset@2026.09");

  const ownerAfter = await readPackage(owner.id);
  assert.equal(ownerAfter.body.packageState?.loaded, false);
  const otherAfter = await readPackage(other.id);
  assert.equal(otherAfter.body.packageState?.loaded, true);
  assert.equal(otherAfter.body.packageState?.boundaryId, "bnd-gold-0001");

  const reselect = await choose("fedramp-rev5", owner.id);
  assert.equal(reselect.response.status, 200);
  assert.equal(reselect.body.packageState?.loaded, false);
  assert.equal(reselect.body.packageState?.catalog.id, "fedramp-rev5");

  const missed = await resetWorkspaceRoute(new Request("http://127.0.0.1/api/workspace/reset", { method: "POST" }));
  const missedBody = (await missed.json()) as PackageBody;
  assert.equal(missed.status, 200);
  assert.equal(missedBody.packageState?.loaded, false);
  const otherStill = await readPackage(other.id);
  assert.equal(otherStill.body.packageState?.loaded, true);
  assert.equal(otherStill.body.packageState?.workspaceName, "Gold fixture CSP boundary");
});

test("a cold cache reloads the loaded package and WIP export does not ask to load again", async () => {
  const owner = await choose("fedramp-rev5");
  const gold = await postJson(loadFixture, "http://127.0.0.1/api/fixtures/load", { fixture: "gold" }, owner.id);
  const goldBody = (await gold.json()) as PackageBody;
  assert.equal(gold.status, 200, JSON.stringify(goldBody));
  assert.equal(goldBody.packageState?.loaded, true);

  dropCachedSession(owner.id);
  const again = await readPackage(owner.id);
  assert.equal(again.body.packageState?.loaded, true);
  assert.equal(again.body.packageState?.boundaryId, "bnd-gold-0001");
  assert.equal(again.body.packageState?.workspaceName, "Gold fixture CSP boundary");

  const exported = await postJson(exportOscalRoute, "http://127.0.0.1/api/oscal/export", {}, owner.id);
  const exportedBody = (await exported.json()) as PackageBody & {
    filename?: string;
    packageState?: PackageBody["packageState"] & { gate?: { status: string } };
    error?: { message: string };
  };
  assert.equal(exported.status, 200, JSON.stringify(exportedBody));
  assert.equal(exportedBody.filename, "exp-0001-package-oscal.xml");
  assert.equal(exportedBody.packageState?.gate?.status, "FAIL");
  assert.equal(exportedBody.error, undefined);

  const artifact = await getOscal(new Request("http://127.0.0.1/api/artifacts/oscal", { headers: cookieHeader(owner.id) }));
  assert.equal(artifact.status, 200);
  assert.match(artifact.headers.get("content-disposition") ?? "", /filename="exp-0001-package-oscal\.xml"/);
  const xml = await artifact.text();
  assert.match(xml, /system-security-plan/);
  assert.match(xml, /bnd-gold-0001/);
});

test("established planning reads do not rewrite cookies after an on-device deletion",async()=>{
 const initial=await getPackage(new Request("http://127.0.0.1/api/package?workspace=sa1-demo"));
 const cookie=initial.headers.getSetCookie().find(c=>c.startsWith("aegis_sa1_sid="))!.split(";")[0];
 const scope=initial.headers.get("x-aegis-session-scope");assert.match(scope!,/^[a-f0-9]{64}$/);
 const read=await getPackage(new Request("http://127.0.0.1/api/package?workspace=sa1-demo",{headers:{cookie}}));
 assert.deepEqual(read.headers.getSetCookie(),[]);assert.equal(read.headers.get("x-aegis-session-scope"),scope);
 const cleared=await getPackage(new Request("http://127.0.0.1/api/package?workspace=sa1-demo"));
 assert.notEqual(cleared.headers.get("x-aegis-session-scope"),scope);assert.equal((await cleared.json()).packageState.loaded,false);
});


test("a delayed review cannot mutate a replacement session or rewrite its cookies",async()=>{
 const {withSession}=await import("../lib/server/http");
 const first=await getPackage(new Request("http://127.0.0.1/api/package?workspace=sa1-demo"));
 const scope=first.headers.get("x-aegis-session-scope")!;
 for(const method of ["GET","PUT"]){
  let ran=false;
  const response=await withSession(new Request("http://127.0.0.1/api/remediation?workspace=sa1-demo",{method,headers:{"x-aegis-workspace":"sa1-demo","x-aegis-expected-session":scope}}),()=>{ran=true;return Response.json({ok:true});});
  assert.equal(ran,false);assert.equal(response.status,409);assert.equal((await response.json()).error.code,"SESSION_CHANGED");assert.deepEqual(response.headers.getSetCookie(),[]);
 }
});
