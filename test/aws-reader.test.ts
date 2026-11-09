import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import Ajv from "ajv";
import { findRepoRoot } from "../lib/aegis/paths";
import { moderateControls } from "../lib/aegis/moderate-baseline";
import { parseEvidenceEvent } from "../lib/builder/evidence";
import { factCandidates } from "../lib/collector/mappings";
import { readCollectedArtifact } from "../lib/collector/read";
import { AccountGuardError, GOVCLOUD_TARGET, accountTarget, stsEndpoint } from "../lib/collector/aws/account";
import { buildCatalogs } from "../lib/collector/aws/catalog";
import { ingestProwler, loadPinnedHashes } from "../lib/collector/aws/ingest";
import { sha256Bytes } from "../lib/collector/aws/jcs";
import {
  READER_SERVICES,
  assertExplicitServicePrefixes,
  evaluateReaderRole,
  readerInlinePolicy,
  type PolicyDocument,
} from "../lib/collector/aws/policy";
import { assertNoSecrets } from "../lib/collector/aws/redact";
import {
  assertNoStaticKeys,
  assertReaderRole,
  prowlerCommand,
  runAwsScan,
  scanFixture,
  stsCommand,
  type CommandRunner,
} from "../lib/collector/aws/run";
import { checksSha256, etTimestamp, scanFilename, verifyRecord, type AwsScanRecord } from "../lib/collector/aws/scan-record";
import checkCatalogJson from "../catalogs/aws-reader-checks.json" with { type: "json" };
import ksiCatalogJson from "../catalogs/ksi-2026.10.13.01.json" with { type: "json" };
import pinJson from "../catalogs/aws-reader-pin.json" with { type: "json" };
import scanSchema from "../schemas/aws-scan-record.schema.json" with { type: "json" };

const root = findRepoRoot();
const require = createRequire(path.join(root, "package.json"));
const tsx = require.resolve("tsx/cli");
const capturedAt = "2026-10-25T18:00:00.000Z";
const now = new Date(capturedAt);
const gitCommit = "a".repeat(40);
const RULES_SHA = "fb48d677a85d77fb72735a325de2c1945a1e0ceab1d2e655292fe9ebe3e4e0b4";
const FRAMEWORK_SHA = "cc1a5fa8c88ee4e327c84ae871b8e51553b4d0c614193a25a0d5490449a8e766";
const SECRET = /AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:password|secretAccessKey|sessionToken|aws_secret_access_key|aws_session_token)\s*[:=]\s*\S+/i;

const validateScan = new Ajv({ allErrors: true, strict: false, validateSchema: false }).compile(scanSchema);

function fixtureDir(name: string): string {
  return path.join(root, "fixtures/aws", name);
}

function loadFixture(name: string): { caller: unknown; findings: unknown[] } {
  const dir = fixtureDir(name);
  return {
    caller: JSON.parse(readFileSync(path.join(dir, "caller.json"), "utf8")) as unknown,
    findings: JSON.parse(readFileSync(path.join(dir, "prowler.ocsf.json"), "utf8")) as unknown[],
  };
}

function ingest(name: string, runId: string, patch?: (findings: unknown[]) => unknown[]) {
  const loaded = loadFixture(name);
  return ingestProwler({
    findings: patch ? patch(structuredClone(loaded.findings)) : loaded.findings,
    caller: loaded.caller as { Account: string; Arn: string; UserId: string },
    capturedAt,
    trigger: "fixture",
    now,
    runId,
    gitCommit,
  });
}

function ksi(record: AwsScanRecord, id: string) {
  const item = record.ksis.find((entry) => entry.ksi_id === id);
  assert.ok(item, id);
  return item;
}

test("pinned catalogs have 46 KSIs and match the generator", () => {
  const hashes = loadPinnedHashes(root);
  assert.equal(hashes.rules, RULES_SHA);
  assert.equal(hashes.framework, FRAMEWORK_SHA);
  assert.equal(pinJson.rules.sha256, RULES_SHA);
  assert.equal(pinJson.rules.version, "2026.10.13.01");
  assert.equal(pinJson.prowler.framework_sha256, FRAMEWORK_SHA);
  assert.equal(ksiCatalogJson.ksis.length, 46);
  const rulesPath = path.join(root, "catalogs/upstream/fedramp-consolidated-rules-2026.10.13.01.json");
  const frameworkPath = path.join(root, "catalogs/upstream/prowler-fedramp-20x-ksi-2026.json");
  const built = buildCatalogs(JSON.parse(readFileSync(rulesPath, "utf8")), JSON.parse(readFileSync(frameworkPath, "utf8")), sha256Bytes(readFileSync(rulesPath)));
  assert.deepEqual(built.ksis, ksiCatalogJson);
  assert.deepEqual(built.checks, checkCatalogJson);
  const scopes = { process: 0, account: 0, workload: 0 };
  for (const item of ksiCatalogJson.ksis) {
    if (item.scope !== "process" && item.scope !== "account" && item.scope !== "workload") throw new Error(`Unexpected KSI scope ${item.scope}`);
    scopes[item.scope] += 1;
  }
  assert.deepEqual(scopes, { process: 13, account: 30, workload: 3 });
  assert.deepEqual(ksiCatalogJson.ksis.filter((item) => item.class_variance).map((item) => item.ksi_id), [
    "KSI-CNA-EIS", "KSI-MLA-ALA", "KSI-SVC-PRR", "KSI-SVC-RUD", "KSI-SVC-VCM",
  ]);
});

test("empty, hardened, and access-denied fixtures roll up the 46 KSIs", () => {
  const empty = ingest("empty-account", "run-empty").record;
  const hardened = ingest("hardened-account", "run-hardened").record;
  const denied = ingest("access-denied", "run-denied").record;
  assert.equal(empty.ksis.length, 46);
  assert.deepEqual(empty.summary, { pass: 0, fail: 30, not_applicable: 3, error: 0, manual: 13 });
  assert.deepEqual(hardened.summary, { pass: 30, fail: 0, not_applicable: 3, error: 0, manual: 13 });
  assert.deepEqual(denied.summary, { pass: 0, fail: 0, not_applicable: 0, error: 33, manual: 13 });
  assert.equal(etTimestamp(now), "2026-10-25T14:00:00-04:00");
  assert.equal(empty.run.started_et, "2026-10-25T14:00:00-04:00");
  assert.equal(validateScan(empty), true, JSON.stringify(validateScan.errors));
  verifyRecord(empty);
  assert.equal(JSON.stringify(empty).includes("UserId"), false);
  assert.equal(JSON.stringify(empty).includes("AROAEXAMPLE"), false);

  for (const record of [empty, hardened]) {
    assert.equal(ksi(record, "KSI-CED-RAT").result, "manual");
    assert.equal(ksi(record, "KSI-CED-RAT").check_ids.length, 0);
    assert.equal(ksi(record, "KSI-CNA-RVP").result, "not_applicable");
    assert.equal(ksi(record, "KSI-CNA-RVP").check_ids.length, 20);
    assert.equal(ksi(record, "KSI-CNA-OFA").result, "not_applicable");
    assert.equal(ksi(record, "KSI-CNA-OFA").check_ids.length, 36);
    assert.equal(ksi(record, "KSI-CNA-OFA").check_ids.includes("dynamodb_tables_pitr_enabled"), false);
    assert.equal(ksi(record, "KSI-SVC-VCM").result, "not_applicable");
    assert.equal(ksi(record, "KSI-SVC-VCM").check_ids.length, 3);
  }
  assert.equal(ksi(empty, "KSI-CMT-LMC").result, "fail");
  assert.equal(ksi(empty, "KSI-CMT-LMC").check_ids.length, 16);
  assert.equal(ksi(hardened, "KSI-CMT-LMC").result, "pass");
  assert.equal(ksi(empty, "KSI-SVC-ASM").result, "fail");
  assert.equal(ksi(empty, "KSI-SVC-ASM").check_ids.length, 33);
  assert.equal(ksi(hardened, "KSI-SVC-ASM").result, "pass");
  assert.equal(ksi(empty, "KSI-IAM-APM").result, "fail");
  assert.equal(ksi(empty, "KSI-IAM-APM").check_ids.length, 13);
  assert.equal(ksi(hardened, "KSI-IAM-APM").result, "pass");
  assert.equal(ksi(empty, "KSI-RPL-ABO").result, "fail");
  assert.equal(ksi(empty, "KSI-RPL-ABO").check_ids.length, 17);
  assert.equal(ksi(empty, "KSI-RPL-ABO").check_ids.includes("dynamodb_tables_pitr_enabled"), true);
  assert.equal(ksi(hardened, "KSI-RPL-ABO").result, "pass");

  const caller = empty.checks.find((check) => check.check_id === "sts_get_caller_identity");
  assert.ok(caller);
  assert.equal(caller.result, "pass");
  assert.equal(caller.region, "us-gov-west-1");
  assert.deepEqual(caller.api_calls, ["sts:GetCallerIdentity"]);
  assert.deepEqual(caller.evidence_excerpt, { status_code: "PASS", status_detail: "aws-us-gov 111122223333" });
  assert.equal(empty.ksis.some((item) => item.check_ids.includes("sts_get_caller_identity")), false);
  assert.equal(denied.checks.filter((check) => check.check_id !== "sts_get_caller_identity").every((check) => check.result === "error"), true);
  assert.equal(denied.checks.some((check) => check.check_id !== "sts_get_caller_identity" && check.result === "pass"), false);
});

test("collector artifacts and events stay on the shared pipeline", () => {
  const ingested = ingest("empty-account", "run-pipeline");
  assert.equal(ingested.artifacts.length, 2);
  assert.equal(ingested.events.length, 2);
  const allowed = new Set(moderateControls().map((control) => control.id));
  for (const artifact of ingested.artifacts) {
    const read = readCollectedArtifact(artifact);
    assert.ok(read);
    assert.equal(read.source.kind, "aws-account");
    assert.equal("repo" in read.source, false);
    assert.equal("commit" in read.source, false);
    assert.ok(read.facts.some((fact) => fact.key === "log-config" && fact.outcome === "fail"));
  }
  const west = ingested.artifacts.find((artifact) => artifact.source.kind === "aws-account" && artifact.source.region === "us-gov-west-1");
  assert.ok(west);
  const failed = west.facts.filter((fact) => fact.key === "log-config" && fact.outcome === "fail");
  const candidates = factCandidates({ ...west, facts: failed.slice(0, 1) }, allowed, "fedramp-rev5");
  assert.ok(candidates.length > 0);
  assert.equal(candidates[0]?.coverageOnly, true);
  for (const event of ingested.events) {
    const parsed = parseEvidenceEvent(JSON.parse(event.rawEvent));
    assert.equal(parsed.schema, "aegis.evidence-event.v1");
    assert.equal(parsed.subject.kind, "infrastructure");
    assert.equal(parsed.checks[0]?.id, "source-inventory");
    assert.equal(parsed.checks[0]?.verdict, "unknown");
    assert.ok(Buffer.byteLength(event.rawEvent) <= 512_000);
  }
});

test("evidence hashes are stable across run ids and reject tamper", () => {
  const first = ingest("empty-account", "run-hash-a").record;
  const second = ingest("empty-account", "run-hash-b").record;
  assert.equal(first.integrity.checks_sha256, second.integrity.checks_sha256);
  assert.notEqual(first.integrity.sha256, second.integrity.sha256);
  assert.equal(first.integrity.checks_sha256, checksSha256(first));
  assert.equal(scanFilename(first.run.finished_utc, first.integrity.sha256).startsWith("scan-20261025T180000Z-"), true);

  const tampered = structuredClone(first);
  tampered.checks[0].evidence_excerpt.status_detail = `${tampered.checks[0].evidence_excerpt.status_detail}x`;
  assert.throws(() => verifyRecord(tampered), /hash does not match/);
  assert.notEqual(checksSha256(tampered), first.integrity.checks_sha256);

  const changed = ingest("empty-account", "run-hash-a", (findings) => {
    const finding = findings[0] as { status_detail: string };
    finding.status_detail = `${finding.status_detail}x`;
    return findings;
  }).record;
  assert.notEqual(changed.integrity.checks_sha256, first.integrity.checks_sha256);
  verifyRecord(changed);
});

test("the account guard refuses other accounts, partitions, and regions", () => {
  assert.throws(() => scanFixture(fixtureDir("refused-account"), gitCommit, capturedAt), AccountGuardError);
  const commercial = loadFixture("empty-account");
  (commercial.caller as { Arn: string }).Arn = "arn:aws:sts::111122223333:assumed-role/aegis-evidence-reader/fixture";
  assert.throws(() => ingestProwler({ findings: commercial.findings, caller: commercial.caller as { Account: string; Arn: string; UserId: string }, capturedAt, trigger: "fixture", now, runId: "run-commercial", gitCommit }), /arn:aws-us-gov/);
  assert.throws(() => ingest("empty-account", "run-east", (findings) => {
    (findings[0] as { cloud: { region: string } }).cloud.region = "us-east-1";
    return findings;
  }), /us-east-1/);
  assert.throws(() => ingest("empty-account", "run-arn", (findings) => {
    (findings[0] as { resources: { uid: string }[] }).resources[0].uid = "arn:aws:iam::111122223333:root";
    return findings;
  }), /not in aws-us-gov/);
  assert.equal(stsEndpoint("us-gov-west-1"), "https://sts.us-gov-west-1.amazonaws.com");
  assert.throws(() => stsEndpoint("us-east-1"), AccountGuardError);

  const out = mkdtempSync(path.join(tmpdir(), "aegis-aws-refused-"));
  assert.equal(runAwsScan(["--fixture", fixtureDir("refused-account"), "--out", out]), 1);
  assert.equal(readdirSync(out).length, 0);
  assert.equal(runAwsScan(["--regions", "us-east-1", "--fixture", fixtureDir("empty-account"), "--out", out]), 2);
  assert.equal(runAwsScan(["--fixture", fixtureDir("empty-account"), "--profile", "aegis-gov-reader", "--out", out]), 2);
  assert.equal(runAwsScan(["--profile", "bad profile", "--out", out]), 2);
});

test("reader policy allows GovCloud reads and denies mutation, data reads, and commercial regions", () => {
  const policy = readerInlinePolicy();
  const file = JSON.parse(readFileSync(path.join(root, "infra/reader-role/policy.json"), "utf8")) as PolicyDocument;
  assert.deepEqual(file, policy);
  assert.ok(Buffer.byteLength(readFileSync(path.join(root, "infra/reader-role/policy.json"))) < 10240);
  assert.equal(READER_SERVICES.length, 50);
  assertExplicitServicePrefixes(policy);
  assert.throws(() => assertExplicitServicePrefixes({ Version: "2012-10-17", Statement: [{ Effect: "Deny", Action: "*:Create*" }] }), /wildcard service prefix/);
  assert.equal(evaluateReaderRole(policy, "ec2:DescribeInstances", "us-gov-west-1"), "allowed");
  assert.equal(evaluateReaderRole(policy, "ec2:DescribeInstances", "us-gov-east-1"), "allowed");
  assert.equal(evaluateReaderRole(policy, "ec2:DescribeInstances", "us-east-1"), "explicitDeny");
  assert.equal(evaluateReaderRole(policy, "iam:GenerateCredentialReport", "us-gov-west-1"), "allowed");
  assert.equal(evaluateReaderRole(policy, "sts:GetCallerIdentity", "us-gov-west-1"), "allowed");
  assert.equal(evaluateReaderRole(policy, "iam:CreateUser", "us-gov-west-1"), "explicitDeny");
  assert.equal(evaluateReaderRole(policy, "iam:CreateAccessKey", "us-gov-west-1"), "explicitDeny");
  assert.equal(evaluateReaderRole(policy, "s3:PutObject", "us-gov-west-1"), "explicitDeny");
  assert.equal(evaluateReaderRole(policy, "s3:GetObject", "us-gov-west-1"), "explicitDeny");
  assert.equal(evaluateReaderRole(policy, "secretsmanager:GetSecretValue", "us-gov-west-1"), "explicitDeny");
  assert.equal(evaluateReaderRole(policy, "kms:Decrypt", "us-gov-west-1"), "explicitDeny");
  assert.equal(evaluateReaderRole(policy, "kms:GenerateDataKey", "us-gov-west-1"), "explicitDeny");
  assert.equal(evaluateReaderRole(policy, "ssm:GetParameter", "us-gov-west-1"), "explicitDeny");
  assert.equal(evaluateReaderRole(policy, "logs:GetLogEvents", "us-gov-west-1"), "explicitDeny");
  assert.equal(evaluateReaderRole(policy, "logs:FilterLogEvents", "us-gov-east-1"), "explicitDeny");
});

test("the live command calls only caller identity and Prowler", context => {
  context.mock.timers.enable({apis:["Date"],now:new Date("2026-11-04T00:00:00Z")});
  const sts = stsCommand("aegis-gov-reader");
  assert.deepEqual(sts.args, [
    "sts", "get-caller-identity", "--region", "us-gov-west-1",
    "--endpoint-url", "https://sts.us-gov-west-1.amazonaws.com", "--output", "json", "--profile", "aegis-gov-reader",
  ]);
  const prowler = prowlerCommand({ profile: "aegis-gov-reader", regions: ["us-gov-west-1", "us-gov-east-1"], outDir: "/tmp/prowler-out" });
  assert.equal(prowler.file, "prowler");
  assert.equal(prowler.env.AWS_USE_FIPS_ENDPOINT, "true");
  assert.equal(prowler.env.AWS_REGION, "us-gov-west-1");
  assert.equal(prowler.env.PROWLER_AWS_PARTITION, "aws-us-gov");
  assert.match(prowler.args.join(" "), /--compliance fedramp_20x_ksi_2026/);
  assert.match(prowler.args.join(" "), /json-ocsf/);
  assert.equal(prowler.args.includes("--scan-unused-services"), false);
  assert.match(prowler.args.join(" "), /--no-banner/);
  assert.equal(prowler.args.some((arg) => /^(?:fixer|remediat|delete|create|put|update)(?:-|$)/i.test(arg.replace(/^-+/, ""))), false);
  assert.throws(() => assertNoStaticKeys({ AWS_ACCESS_KEY_ID: "local" }), /static AWS access keys/);
  assert.throws(() => assertNoStaticKeys({ AWS_SECRET_ACCESS_KEY: "local" }), /static AWS access keys/);
  assert.doesNotThrow(() => assertNoStaticKeys({ AWS_SESSION_TOKEN: "sso-session" }));

  const out = mkdtempSync(path.join(tmpdir(), "aegis-aws-live-"));
  const calls: string[][] = [];
  const caller = loadFixture("empty-account").caller;
  const runner: CommandRunner = (file, args) => {
    calls.push([file, ...args]);
    if (file === "aws") {
      assert.deepEqual(args.slice(0, 2), ["sts", "get-caller-identity"]);
      return JSON.stringify(caller);
    }
    if (args[0] === "--version") return "Prowler 5.45.0";
    assert.equal(args.some((arg) => /^(?:fixer|remediat|delete|create|put|update)(?:-|$)/i.test(arg.replace(/^-+/, ""))), false);
    const dir = args[args.indexOf("--output-directory") + 1];
    context.mock.timers.tick(2500);
    writeFileSync(path.join(dir, "report.ocsf.json"), readFileSync(path.join(fixtureDir("empty-account"), "prowler.ocsf.json")));
    return "";
  };
  const code = runAwsScan(["--profile", "aegis-gov-reader", "--regions", "us-gov-west-1,us-gov-east-1", "--out", out], runner);
  assert.equal(code, 0);
  assert.deepEqual(calls.map((call) => call[0]), ["aws", "prowler", "prowler"]);
  const recordPath = readdirSync(out).find((name) => name.startsWith("scan-"));
  assert.ok(recordPath);
  const record = JSON.parse(readFileSync(path.join(out, recordPath), "utf8")) as AwsScanRecord;
  verifyRecord(record);
  assert.equal(record.run.trigger, "local-profile");
  assert.equal(Date.parse(record.run.finished_utc)-Date.parse(record.run.started_utc),2500);
  assert.equal(record.summary.fail, 30);
});

test("required reader role refuses broad callers before starting Prowler", () => {
  const target=GOVCLOUD_TARGET,account=target.allowedAccountIds[0];
  const role=`arn:aws-us-gov:iam::${account}:role/AegisPhase7EvidenceReader`;
  const caller={Account:account,Arn:`arn:aws-us-gov:sts::${account}:assumed-role/AegisPhase7EvidenceReader/test-session`,UserId:"reader:test-session"};
  assert.doesNotThrow(()=>assertReaderRole(caller,role,target));
  assert.throws(()=>assertReaderRole({...caller,Arn:`arn:aws-us-gov:iam::${account}:user/Administrator`},role,target),/required reader role/);
  assert.throws(()=>assertReaderRole({...caller,Arn:caller.Arn.replace("EvidenceReader/","EvidenceReaderAdmin/")},role,target),/required reader role/);
  assert.throws(()=>assertReaderRole(caller,role.replace("aws-us-gov:","aws:"),target),/outside the target/);
  const commercial=accountTarget({partition:"aws",allowedAccountIds:["123456789012"],regions:["us-east-1"]});
  assert.doesNotThrow(()=>assertReaderRole({Account:"123456789012",Arn:"arn:aws:sts::123456789012:assumed-role/AegisPhase7EvidenceReader/test-session",UserId:"reader:test-session"},"arn:aws:iam::123456789012:role/AegisPhase7EvidenceReader",commercial));
  const calls:string[]=[];
  const runner:CommandRunner=(file)=>{calls.push(file);return JSON.stringify({...caller,Arn:`arn:aws-us-gov:iam::${account}:root`});};
  const out=mkdtempSync(path.join(tmpdir(),"aegis-role-refusal-"));
  assert.equal(runAwsScan(["--profile","aegis-phase7-reader-govcloud","--reader-role-arn",role,"--out",out],runner),1);
  assert.deepEqual(calls,["aws"]);
  assert.deepEqual(readdirSync(out),[]);
});

test("fixtures and the reader contain no secret material", () => {
  assert.throws(() => assertNoSecrets("example AKIAIOSFODNN7EXAMPLE", "unit"), /secret pattern/);
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else files.push(full);
    }
  };
  walk(path.join(root, "fixtures/aws"));
  walk(path.join(root, "lib/collector/aws"));
  files.push(path.join(root, "infra/reader-role/policy.json"), path.join(root, "schemas/aws-scan-record.schema.json"));
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    assert.equal(SECRET.test(text), false, file);
    assert.equal(text.includes("AKIAIOSFODNN7EXAMPLE"), false, file);
  }
});

test("aws-scan CLI writes an empty-account record and exits 0", () => {
  const out = mkdtempSync(path.join(tmpdir(), "aegis-aws-cli-"));
  const result = spawnSync(process.execPath, [tsx, path.join(root, "bin/aegis-oscal.ts"), "aws-scan", "--fixture", fixtureDir("empty-account"), "--out", out], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /account 111122223333 partition aws-us-gov/);
  assert.match(result.stdout, /summary pass=0 fail=30 not_applicable=3 error=0 manual=13/);
  const recordPath = readdirSync(out).find((name) => name.startsWith("scan-"));
  assert.ok(recordPath);
  verifyRecord(JSON.parse(readFileSync(path.join(out, recordPath), "utf8")) as AwsScanRecord);
});

test("github-oidc trigger is selected when Actions has no profile", () => {
  const bin = mkdtempSync(path.join(tmpdir(), "aegis-aws-bin-"));
  const out = mkdtempSync(path.join(tmpdir(), "aegis-aws-oidc-"));
  const fixture = path.join(fixtureDir("empty-account"), "prowler.ocsf.json");
  const caller = readFileSync(path.join(fixtureDir("empty-account"), "caller.json"), "utf8");
  writeFileSync(path.join(bin, "aws"), `#!/bin/sh\nprintf '%s' '${caller.replace(/'/g, `'\\''`)}'\n`);
  writeFileSync(path.join(bin, "prowler"), `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "Prowler 5.45.0"; exit 0; fi\nfor arg in "$@"; do\n  case "$arg" in --fixer*|--remediat*|--delete*|--create*|--put-*|--update*) echo "write flag" >&2; exit 1;; esac\ndone\nout=""\nprev=""\nfor arg in "$@"; do\n  if [ "$prev" = "--output-directory" ]; then out="$arg"; fi\n  prev="$arg"\ndone\ncp ${JSON.stringify(fixture)} "$out/report.ocsf.json"\n`);
  chmodSync(path.join(bin, "aws"), 0o755);
  chmodSync(path.join(bin, "prowler"), 0o755);
  mkdirSync(out, { recursive: true });
  const result = spawnSync(process.execPath, [tsx, path.join(root, "scripts/collect-aws.ts"), "--out", out], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, GITHUB_ACTIONS: "true", PATH: `${bin}:${process.env.PATH ?? ""}`, AWS_ACCESS_KEY_ID: "", AWS_SECRET_ACCESS_KEY: "" },
  });
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.match(result.stderr, /sts:GetCallerIdentity/);
  assert.match(result.stderr, /prowler:fedramp_20x_ksi_2026/);
  const record = JSON.parse(readFileSync(path.join(out, readdirSync(out).find((name) => name.startsWith("scan-")) ?? ""), "utf8")) as AwsScanRecord;
  assert.equal(record.run.trigger, "github-oidc");
});

test("multiple resources cannot hide a failing or unavailable AWS check behind a later PASS", () => {
  const source = loadFixture("empty-account");
  const original = structuredClone(source.findings[0]) as any;
  const fail = {...original, status_code: "FAIL", status_detail: "Resource failed"};
  const pass = {...original, status_code: "PASS", status_detail: "Different resource passed"};
  const denied = {...original, status_code: "FAIL", status_detail: "AccessDenied for another resource"};
  const capture = (findings: unknown[]) => ingestProwler({findings, caller: source.caller as any, capturedAt, trigger: "fixture", now, gitCommit}).record;
  const selected = (record: AwsScanRecord) => record.checks.find(c => c.check_id === original.metadata.event_code && c.region === original.cloud.region)!;
  const forward = selected(capture([fail, pass])), reverse = selected(capture([pass, fail]));
  assert.equal(forward.result, "fail");
  assert.equal(reverse.result, "fail");
  assert.equal(forward.response_sha256, reverse.response_sha256);
  assert.notEqual(forward.response_sha256, selected(capture([pass])).response_sha256);
  assert.equal(selected(capture([fail, denied, pass])).result, "error");
  assert.equal(selected(capture([pass, pass])).result, "pass");
});

test("completed Prowler exit 3 retains failed findings; fatal or missing report remains a failure", () => {
  for (const [exit, report, expected] of [[3, true, 0], [2, true, 1], [3, false, 1]] as const) {
    const bin = mkdtempSync(path.join(tmpdir(), "aegis-prowler-exit-"));
    const out = mkdtempSync(path.join(tmpdir(), "aegis-prowler-result-"));
    const caller = readFileSync(path.join(fixtureDir("empty-account"), "caller.json"), "utf8");
    writeFileSync(path.join(bin, "aws"), `#!/bin/sh\nprintf '%s' '${caller.replace(/'/g, `'\\''`)}'\n`);
    const fixture = path.join(fixtureDir("empty-account"), "prowler.ocsf.json");
    writeFileSync(path.join(bin, "prowler"), `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 'Prowler 5.45.0'; exit 0; fi\nout=''; prev=''; for arg in "$@"; do if [ "$prev" = "--output-directory" ]; then out="$arg"; fi; prev="$arg"; done\n${report ? `cp '${fixture}' "$out/report.ocsf.json"` : ':'}\nexit ${exit}\n`);
    chmodSync(path.join(bin, "aws"), 0o755); chmodSync(path.join(bin, "prowler"), 0o755);
    const result = spawnSync(process.execPath, [tsx, path.join(root, "scripts/collect-aws.ts"), "--profile", "test-profile", "--out", out], {cwd: root, encoding: "utf8", env: {...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, AWS_ACCESS_KEY_ID: "", AWS_SECRET_ACCESS_KEY: ""}});
    assert.equal(result.status, expected, result.stderr);
    const records = readdirSync(out).filter(n => n.startsWith("scan-"));
    assert.equal(records.length, expected === 0 ? 1 : 0);
    if (expected === 0) {
      const record = JSON.parse(readFileSync(path.join(out, records[0]), "utf8")) as AwsScanRecord;
      verifyRecord(record); assert.ok(record.summary.fail > 0);
    }
  }
});

test("AWS-managed IAM policy references require the target partition and keep caller account guards", () => {
  const source = loadFixture("empty-account");
  const original = structuredClone(source.findings[0]) as any;
  const make = (uid: string) => ({...original, resources: [{uid}]});
  const capture = (finding: unknown) => ingestProwler({findings:[finding], caller:source.caller as any,capturedAt,trigger:"fixture",now,gitCommit});
  assert.doesNotThrow(() => capture(make("arn:aws-us-gov:iam::aws:policy/SecurityAudit")));
  assert.throws(() => capture(make("arn:aws:iam::aws:policy/SecurityAudit")), /resource ARN/);
  assert.throws(() => capture(make("arn:aws-us-gov:iam::111111111111:policy/Foreign")), /resource ARN/);
  const wrong = make("arn:aws-us-gov:iam::aws:policy/SecurityAudit"); wrong.cloud.account.uid="111111111111";
  assert.throws(() => capture(wrong), /outside configured target/);
});

test("only the exact Prowler GovCloud no-events enclave placeholder becomes an error", () => {
  const source = loadFixture("empty-account");
  const original = structuredClone(source.findings[0]) as any;
  const check = "kms_key_enclave_debug_attestation_detected";
  const marker = {...original,metadata:{...original.metadata,event_code:check},status_code:"MANUAL",resources:[{uid:`arn:aws:kms:${original.cloud.region}:${(source.caller as any).Account}:enclave-debug-attestation`}]};
  const capture = (finding: unknown) => ingestProwler({findings:[finding],caller:source.caller as any,capturedAt,trigger:"fixture",now,gitCommit});
  const result = capture(marker).record.checks.find(c => c.check_id===check && c.region===original.cloud.region)!;
  assert.equal(result.result,"error"); assert.match(result.evidence_excerpt.status_detail,/unavailable/);
  assert.throws(() => capture({...marker,status_code:"PASS"}),/resource ARN/);
  assert.throws(() => capture({...marker,status_code:"FAIL"}),/resource ARN/);
  assert.throws(() => capture({...marker,metadata:{...marker.metadata,event_code:"different_check"}}),/resource ARN/);
});
