import {referenceProposals as proposePlans} from "./support/reference-history";
import assert from "node:assert/strict";
import test from "node:test";
import { readRemediationCookie, remediationSessionCookie } from "../lib/server/remediation-session";
import { decisionFromProposal } from "../lib/aegis/plan-proposal";
import { CCM_EXAMPLE } from "../lib/aegis/pipeline-evidence";
import { saveRemediationRecord } from "../lib/client/remediation-save";
import type { RemediationRecord } from "../lib/aegis/remediation-store";

const secret = Buffer.alloc(32, 17), sid = "ab".repeat(16), now = Date.now();
const req = new Request("https://example.test/api/remediation");
const decision = decisionFromProposal(proposePlans([CCM_EXAMPLE])[0], { acceptance: "accepted" });
const record: RemediationRecord = { key: "proposals:podinfo", assessment: null, assessments: {}, plans: [], proposals: [decision] };
function cookie(next = record) { return remediationSessionCookie(next, sid, req, secret, now).split(";")[0]; }
function tamperCookie(encoded: string) {
  return encoded.replace(/=(.)/, (_match, first: string) => first === "X" ? "=Y" : "=X");
}

test("fallback records are encrypted, session-bound, authenticated and expired on the server", () => {
  const encoded = cookie();
  assert.deepEqual(readRemediationCookie(encoded, sid, secret, now), [record]);
  assert.equal(encoded.includes("accepted"), false);
  assert.deepEqual(readRemediationCookie(encoded, "cd".repeat(16), secret, now), []);
  assert.deepEqual(readRemediationCookie(encoded, sid, Buffer.alloc(32, 18), now), []);
  // Exercise both branches without relying on the random IV to start with X.
  assert.equal(tamperCookie("cookie=Xrest"), "cookie=Yrest");
  assert.equal(tamperCookie("cookie=Arest"), "cookie=Xrest");
  const tampered = tamperCookie(encoded);
  assert.notEqual(tampered, encoded);
  assert.deepEqual(readRemediationCookie(tampered, sid, secret, now), []);
  assert.deepEqual(readRemediationCookie(encoded, sid, secret, now + 24 * 60 * 60 * 1000), []);
  assert.deepEqual(readRemediationCookie(`aegis_remediation=${Buffer.from(JSON.stringify([record])).toString("base64url")}`, sid, secret, now), []);
  const attributes = remediationSessionCookie(record, sid, req, secret, now);
  assert.match(attributes, /HttpOnly; SameSite=Lax/);
  assert.match(attributes, /; Secure$/);
});

test("independent record cookies survive overlapping saves and renaming a cookie fails authentication", () => {
  const first = cookie();
  const second = cookie({ ...record, key: "another:record" });
  assert.equal(readRemediationCookie(`${first}; ${second}`, sid, secret, now).length, 2);
  const renamed = `${second.split("=")[0]}=${first.split("=")[1]}`;
  assert.deepEqual(readRemediationCookie(renamed, sid, secret, now), []);
});

test("historical cookie triage is ignored while supported saved proposals survive", () => {
  const encoded = cookie({ ...record, issueTriage: [{ outcome: "accept-risk", reason: "Historical only" }] });
  assert.deepEqual(readRemediationCookie(encoded, sid, secret, now), [record]);
});

test("production fallback requires a stable configured key", () => {
  const previous = process.env.NODE_ENV, previousKey = process.env.AEGIS_REMEDIATION_COOKIE_KEY;
  Object.assign(process.env, { NODE_ENV: "production" });
  delete process.env.AEGIS_REMEDIATION_COOKIE_KEY;
  try { assert.throws(() => remediationSessionCookie(record, sid, req), /not configured/); }
  finally { if (previous === undefined) Reflect.deleteProperty(process.env, "NODE_ENV"); else Object.assign(process.env, { NODE_ENV: previous });
    if (previousKey === undefined) delete process.env.AEGIS_REMEDIATION_COOKIE_KEY; else process.env.AEGIS_REMEDIATION_COOKIE_KEY = previousKey; }
});

test("queued browser saves merge only edited proposals and a failed save does not block the next", async () => {
  const originalFetch = globalThis.fetch;
  let remote: RemediationRecord | null = null, active = 0, peak = 0, fail = false;
  globalThis.fetch = async (_url, init) => {
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active--;
    if (init?.method === "PUT") {
      if (fail) { fail = false; return new Response("{}", { status: 503 }); }
      remote = JSON.parse(init.body as string);
      return new Response("{}");
    }
    return Response.json({ record: remote });
  };
  try {
    const second = { ...decision, id: "proposal:SC-7:2894050908:second", controlId: "SC-7" };
    await Promise.all([
      saveRemediationRecord(record, { proposalIds: [decision.id] }),
      saveRemediationRecord({ ...record, proposals: [second] }, { proposalIds: [second.id] }),
    ]);
    assert.equal(peak, 1);
    assert.deepEqual(remote!.proposals!.map(item => (item as typeof decision).id), [decision.id, second.id]);
    fail = true;
    await assert.rejects(saveRemediationRecord(record), /Could not store/);
    await saveRemediationRecord(record, { proposalIds: [decision.id] });
    assert.equal(remote!.proposals!.length, 2);
  } finally { globalThis.fetch = originalFetch; }
});
