import type { GitArtifactSource } from "../lib/collector/types";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { GET as cron } from "../app/api/monitoring/cron/route";
import { POST as webhook } from "../app/api/monitoring/connections/[id]/webhook/route";
import { POST as captures } from "../app/api/monitoring/connections/[id]/captures/route";
import { GET as timeline } from "../app/api/monitoring/connections/[id]/timeline/[controlId]/route";
import { dataDir } from "../lib/aegis/paths";
import { observationControl } from "../lib/aegis/connected-evidence";
import { BUILDER_COOKIE, createConnection, monitoringRecordKey } from "../lib/server/builder-store";
import { canonicalCapture, captureArtifacts } from "../lib/monitoring/capture";
import { verifyTimeline } from "../lib/monitoring/chain";
import { monitoringCopy } from "../lib/monitoring/copy";
import { cronAuthorized } from "../lib/monitoring/cron-auth";
import { classifyDrift } from "../lib/monitoring/drift";
import { evaluateGate } from "../lib/monitoring/gate";
import { registerCollector, unregisterCollector } from "../lib/monitoring/registry";
import { repoScanner } from "../lib/monitoring/adapters/repo-scanner";
import type { EvidenceEvent } from "../lib/builder/evidence";
import type { MonitorTimelineEntry, SourceCaptureDocument } from "../lib/monitoring/types";

const root = process.cwd();
const fixture = (name: string) => JSON.parse(readFileSync(path.join(root, "test/fixtures/monitoring", name), "utf8")) as SourceCaptureDocument;
const artifacts = (name: string) => captureArtifacts(canonicalCapture(fixture(name)));

test("drift fixtures cover every class and a pass-to-fail regression", () => {
  const rows = classifyDrift(artifacts("drift-previous.json"), artifacts("drift-next.json"));
  const byClass = (drift: string) => rows.filter(row => row.drift === drift).map(row => row.subjectId);
  assert.deepEqual(byClass("new-pass"), ["KSI-IAM"]);
  assert.deepEqual(byClass("still-pass"), ["CM-2", "CM-8"]);
  assert.deepEqual(byClass("still-fail"), ["CM-6"]);
  assert.deepEqual(byClass("removed"), ["AC-4", "SC-7"]);
  const regressions = rows.filter(row => row.regression);
  assert.deepEqual(regressions.map(row => row.subjectId), ["AC-6", "CM-7"]);
  assert.equal(regressions.every(row => row.drift === "new-fail" && row.previous === "pass" && row.outcome === "fail" && row.label === monitoringCopy.classes["new-fail"] && row.regressionLabel === monitoringCopy.regressionLabel), true);
  assert.equal(rows.find(row => row.subjectId === "KSI-IAM")?.subjectKind, "ksi");
  assert.equal(rows.find(row => row.subjectId === "CM-6")?.regression, false);
  assert.equal(rows.find(row => row.subjectId === "AC-4")?.outcome, "absent");
});

test("hash-chain fixtures detect a body edit and a broken link", () => {
  const intact = JSON.parse(readFileSync(path.join(root, "test/fixtures/monitoring/chain-intact.json"), "utf8")) as MonitorTimelineEntry[];
  const tampered = JSON.parse(readFileSync(path.join(root, "test/fixtures/monitoring/chain-tampered.json"), "utf8")) as MonitorTimelineEntry[];
  const relinked = JSON.parse(readFileSync(path.join(root, "test/fixtures/monitoring/chain-relinked.json"), "utf8")) as MonitorTimelineEntry[];
  assert.equal(verifyTimeline(intact).intact, true);
  assert.equal(intact[1].prevHash, intact[0].entryHash);
  assert.equal(verifyTimeline(tampered).intact, false);
  assert.equal(verifyTimeline(relinked).intact, false);
  assert.equal(tampered[1].entryHash, intact[1].entryHash);
  assert.notEqual(tampered[1].outcome, intact[1].outcome);
});

test("gate report is the default and enforce honors the allowlist", () => {
  const rows = classifyDrift(artifacts("baseline-pass.json"), artifacts("regression-fail.json"));
  const blocking = rows.filter(row => row.regression).map(row => row.subjectId);
  assert.deepEqual(blocking, ["AC-6", "CM-6", "CM-7"]);
  assert.equal(evaluateGate(rows, new Set(), "report").exitCode, 0);
  assert.equal(evaluateGate(rows, new Set(), "enforce").exitCode, 1);
  assert.equal(evaluateGate(rows, new Set(["AC-6", "CM-6", "CM-7"]), "enforce").exitCode, 0);
  assert.equal(evaluateGate(rows, new Set(["AC-6"]), "enforce").exitCode, 1);
  assert.equal(evaluateGate(rows, new Set(), "report").title, monitoringCopy.gateTitle);
});

test("repo scanner does not fetch a remote system", async () => {
  await assert.rejects(() => repoScanner.collect({ trigger: { kind: "webhook", event: "push", repo: "https://github.com/example/service", revision: "a".repeat(40), at: "2026-10-08T00:00:00.000Z" }, capture: null }), new RegExp(monitoringCopy.remoteFetchRefused.replace(/[.]/g, "\\.")));
});

test("NIST and KSI observation links stay explicit", () => {
  const check = (framework: string, reference: string): EvidenceEvent["checks"][number] => ({ id: "c", version: "1", description: "d", requirement: { framework, reference, objective: "o" }, verdict: "fail", artifacts: ["a.json"], validUntil: "2026-10-09T00:00:00.000Z" });
  assert.equal(observationControl(check("NIST SP 800-53 Rev 5", "ac-6")), "AC-6");
  assert.equal(observationControl(check("FedRAMP 20x", "ksi-iam")), "KSI-IAM");
  assert.equal(observationControl(check("Evidence inventory", "source-facts")), null);
});

test("cron credential comparison fails closed", () => {
  assert.equal(cronAuthorized(null, undefined), false);
  assert.equal(cronAuthorized("Bearer secret-value-012345", undefined), false);
  assert.equal(cronAuthorized("Bearer wrong-value-000000", "secret-value-012345"), false);
  assert.equal(cronAuthorized("Bearer short", "secret-value-012345"), false);
  assert.equal(cronAuthorized("Bearer secret-value-012345", "secret-value-012345"), true);
});

function gate(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", "scripts/monitor-gate.ts", ...args], { cwd: root, encoding: "utf8" });
}

test("gate CLI exits 0, 1, and 2", () => {
  const base = ["--capture", "test/fixtures/monitoring/regression-fail.json", "--baseline", "test/fixtures/monitoring/baseline-pass.json"];
  const report = gate(base);
  assert.equal(report.status, 0);
  assert.match(report.stdout, /Continuous monitoring gate report/);
  assert.match(report.stdout, /AC-6/);
  const enforced = gate([...base, "--enforce"]);
  assert.equal(enforced.status, 1);
  assert.match(enforced.stdout, new RegExp(monitoringCopy.gateBlocking));
  const allowed = gate([...base, "--enforce", "--allow", "ac-6, cm-6, cm-7"]);
  assert.equal(allowed.status, 0);
  assert.equal(JSON.parse(allowed.stdout).blocking.length, 0);
  const partial = gate([...base, "--enforce", "--allow", "AC-6"]);
  assert.equal(partial.status, 1);
  const usage = gate(["--capture", "missing.json"]);
  assert.equal(usage.status, 2);
});

test("CI upload script keeps the token out of the error text", () => {
  const token = "d".repeat(64);
  const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/monitor-ci.ts", "--capture", "test/fixtures/monitoring/baseline-pass.json", "--endpoint", "http://127.0.0.1:9/api/monitoring/connections/11111111-1111-4111-8111-111111111111/captures"], {
    cwd: root, encoding: "utf8", env: { ...process.env, AEGIS_BUILDER_TOKEN: token },
  });
  assert.equal(result.status, 1);
  assert.equal(`${result.stdout}${result.stderr}`.includes(token), false);
  const usage = spawnSync(process.execPath, ["--import", "tsx", "scripts/monitor-ci.ts"], { cwd: root, encoding: "utf8" });
  assert.equal(usage.status, 2);
});

test("monitoring routes retain regressions as unaccepted drafts and reject a tampered chain", async () => {
  const previousData = process.env.AEGIS_DATA_DIR;
  const previousCron = process.env.CRON_SECRET;
  const dir = mkdtempSync(path.join(os.tmpdir(), "monitor-"));
  process.env.AEGIS_DATA_DIR = dir;
  const owner = "ab".repeat(32);
  const otherOwner = "cd".repeat(32);
  try {
    const created = await createConnection("Watched system", owner, dir);
    const other = await createConnection("Other system", otherOwner, dir);
    const context = (id: string) => ({ params: Promise.resolve({ id }) });
    const controlContext = (id: string, controlId: string) => ({ params: Promise.resolve({ id, controlId }) });
    const post = (route: typeof webhook, kind: "webhook" | "ci", id: string, token: string, document: SourceCaptureDocument, event?: "push" | "merge") => route(new Request(`http://localhost/api/monitoring/connections/${id}/${kind === "webhook" ? "webhook" : "captures"}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        adapter: "repo-scanner",
        trigger: { kind, ...(event ? { event } : {}), repo: document.captures[0].source.repo, revision: document.captures[0].source.commit, at: document.captures[0].source.capturedAt, runId: "run-1" },
        capture: document,
        authorization: "Bearer ghp_thismustnotbestored1234567890",
      }),
    }), context(id));

    const baseline = fixture("baseline-pass.json");
    const opened = await post(captures, "ci", created.connection.id, created.token, baseline);
    assert.equal(opened.status, 201);
    const openedBody = await opened.json() as { drift: { drift: string; regression: boolean }[]; drafts: unknown[] };
    assert.equal(openedBody.drafts.length, 0);
    assert.equal(openedBody.drift.every(row => row.drift === "new-pass" && !row.regression), true);

    const regressed = await post(webhook, "webhook", created.connection.id, created.token, fixture("regression-fail.json"), "push");
    assert.equal(regressed.status, 201);
    const regressedBody = await regressed.json() as { drafts: { acceptance: string; disposition: string; control: string }[]; drift: { subjectId: string; regression: boolean; label: string }[] };
    assert.deepEqual(regressedBody.drafts.map(draft => draft.control).sort(), ["AC-6", "CM-6", "CM-7"]);
    assert.equal(regressedBody.drafts.every(draft => draft.acceptance === "proposed" && draft.disposition === "needs-verification"), true);
    assert.equal(regressedBody.drift.find(row => row.subjectId === "CM-2")?.regression, false);
    assert.equal(regressedBody.drift.find(row => row.subjectId === "AC-6")?.label, monitoringCopy.classes["new-fail"]);

    const replay = await post(webhook, "webhook", created.connection.id, created.token, fixture("regression-fail.json"), "push");
    assert.equal(replay.status, 200);
    assert.equal((await replay.json() as { replayed: boolean }).replayed, true);

    const denied = await webhook(new Request("http://localhost/api/monitoring/connections/x/webhook", { method: "POST", body: "{}" }), context(created.connection.id));
    assert.equal(denied.status, 401);
    const wrongKind = await webhook(new Request("http://localhost/api/monitoring/connections/x/webhook", {
      method: "POST", headers: { authorization: `Bearer ${created.token}`, "content-type": "application/json" },
      body: JSON.stringify({ trigger: { kind: "ci", repo: baseline.captures[0].source.repo, revision: baseline.captures[0].source.commit, at: baseline.captures[0].source.capturedAt }, capture: baseline }),
    }), context(created.connection.id));
    assert.equal(wrongKind.status, 400);

    const read = await timeline(new Request("http://localhost/timeline", { headers: { cookie: `${BUILDER_COOKIE}=${owner}` } }), controlContext(created.connection.id, "ac-6"));
    assert.equal(read.status, 200);
    const body = await read.json() as { chain: { intact: boolean; label: string }; entries: MonitorTimelineEntry[]; emptyLabel: string };
    assert.equal(body.chain.intact, true);
    assert.equal(body.chain.label, monitoringCopy.chainIntact);
    assert.equal(body.emptyLabel, "");
    assert.equal(body.entries.length, 2);
    assert.equal(body.entries[1].prevHash, body.entries[0].entryHash);
    assert.equal(body.entries[1].regression, true);
    assert.equal(body.entries[1].draft?.decision.acceptance, "proposed");
    assert.equal(body.entries[1].draft?.plan.readyForReview, false);
    assert.equal(body.entries[1].draft?.plan.closure.recorded, false);
    assert.equal(body.entries[1].draft?.plan.assessment.disposition, "needs-verification");
    assert.match(body.entries[1].problem?.description ?? "", new RegExp(monitoringCopy.objective.replace(/[.]/g, "\\.")));
    const stored = JSON.stringify(body);
    assert.equal(stored.includes(created.token), false);
    assert.equal(stored.includes("ghp_"), false);

    const byToken = await timeline(new Request("http://localhost/timeline", { headers: { authorization: `Bearer ${created.token}` } }), controlContext(created.connection.id, "AC-6"));
    assert.equal(byToken.status, 200);
    const outsider = await timeline(new Request("http://localhost/timeline", { headers: { cookie: `${BUILDER_COOKIE}=${otherOwner}` } }), controlContext(created.connection.id, "AC-6"));
    assert.equal(outsider.status, 404);
    const empty = await timeline(new Request("http://localhost/timeline", { headers: { cookie: `${BUILDER_COOKIE}=${otherOwner}` } }), controlContext(other.connection.id, "AC-6"));
    assert.equal(empty.status, 200);
    assert.equal((await empty.json() as { emptyLabel: string; entries: unknown[] }).emptyLabel, monitoringCopy.emptyTimeline);

    const record = body.entries[1];
    const file = path.join(dataDir(dir), monitoringRecordKey(created.connection.id, "timeline", record.entryHash));
    const edited = JSON.parse(readFileSync(file, "utf8")) as MonitorTimelineEntry;
    edited.outcome = "pass";
    writeFileSync(file, JSON.stringify(edited));
    const broken = await timeline(new Request("http://localhost/timeline", { headers: { authorization: `Bearer ${created.token}` } }), controlContext(created.connection.id, "AC-6"));
    const brokenBody = await broken.json() as { chain: { intact: boolean; label: string } };
    assert.equal(brokenBody.chain.intact, false);
    assert.equal(brokenBody.chain.label, monitoringCopy.chainBroken);
    const later = structuredClone(fixture("regression-fail.json"));
    later.captures[0].source.commit = "c".repeat(40);
    later.captures[0].source.capturedAt = "2026-10-10T00:00:00.000Z";
    later.captures[0].artifacts = later.captures[0].artifacts.map(artifact => ({ ...artifact, source: { ...(artifact.source as GitArtifactSource), commit: "c".repeat(40) }, capturedAt: "2026-10-10T00:00:00.000Z" }));
    const refused = await post(webhook, "webhook", created.connection.id, created.token, later, "merge");
    assert.equal(refused.status, 400);
    assert.match(await refused.text(), new RegExp(monitoringCopy.chainRefused));

    delete process.env.CRON_SECRET;
    assert.equal((await cron(new Request("http://localhost/api/monitoring/cron"))).status, 401);
    process.env.CRON_SECRET = "cron-secret-value-1";
    assert.equal((await cron(new Request("http://localhost/api/monitoring/cron", { headers: { authorization: "Bearer wrong-secret-value" } }))).status, 401);
    const idle = await cron(new Request("http://localhost/api/monitoring/cron", { headers: { authorization: "Bearer cron-secret-value-1" } }));
    assert.equal(idle.status, 200);
    assert.deepEqual((await idle.json() as { scans: unknown[] }).scans, []);

    registerCollector({
      id: "sample-cloud",
      triggers: ["schedule"],
      async collect() { return null; },
      async scheduledScans() {
        const sample = fixture("baseline-pass.json");
        sample.captures[0].source.capturedAt = "2026-10-20T00:00:00.000Z";
        sample.captures[0].source.commit = "d".repeat(40);
        sample.captures[0].artifacts = sample.captures[0].artifacts.map(artifact => ({ ...artifact, capturedAt: "2026-10-20T00:00:00.000Z", source: { ...(artifact.source as GitArtifactSource), commit: "d".repeat(40) } }));
        return [{ connectionId: other.connection.id, trigger: { kind: "schedule" as const, repo: sample.captures[0].source.repo, revision: "d".repeat(40), at: "2026-10-20T00:00:00.000Z" }, capture: sample }];
      },
    });
    const scanned = await cron(new Request("http://localhost/api/monitoring/cron", { headers: { authorization: "Bearer cron-secret-value-1" } }));
    assert.equal(scanned.status, 200);
    const scans = (await scanned.json() as { scans: { connectionId: string; regressions: number }[] }).scans;
    assert.equal(scans.length, 1);
    assert.equal(scans[0].connectionId, other.connection.id);
    assert.equal(scans[0].regressions, 0);
  } finally {
    unregisterCollector("sample-cloud");
    if (previousData == null) delete process.env.AEGIS_DATA_DIR;
    else process.env.AEGIS_DATA_DIR = previousData;
    if (previousCron == null) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previousCron;
    rmSync(dir, { recursive: true, force: true });
  }
});
