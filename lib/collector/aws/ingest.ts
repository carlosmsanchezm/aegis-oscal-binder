import { readFileSync } from "node:fs";
import path from "node:path";
import checkCatalogJson from "../../../catalogs/aws-reader-checks.json" with { type: "json" };
import ksiCatalogJson from "../../../catalogs/ksi-2026.10.13.01.json" with { type: "json" };
import pinJson from "../../../catalogs/aws-reader-pin.json" with { type: "json" };
import { findRepoRoot } from "../../aegis/paths";
import { digest } from "../collect";
import { collectorEvents } from "../events";
import type { CollectedArtifact, EvidenceFact } from "../types";
import {
  GOVCLOUD_TARGET, accountTarget, assertTargetCaller, type AccountTarget,
  PROWLER_FRAMEWORK,
  PROWLER_FRAMEWORK_VERSION,
  PROWLER_LICENSE,
  PROWLER_VERSION,
  READER_NAME,
  READER_VERSION,
  RULES_SOURCE,
  RULES_VERSION,
  type CallerIdentity,
  assertCaller,
} from "./account";
import type { CheckCatalog, CheckRecord, KsiCatalog, KsiRecord } from "./catalog";
import { canonicalSha256, sha256Bytes } from "./jcs";
import { cleanDetail } from "./redact";
import {
  artifactRefs,
  sealRecord,
  summaryFromKsis,
  uuidV7,
  etTimestamp,
  type AwsScanRecord,
  type ScanCheck,
  type ScanKsi,
  type ScanResult,
  type ScanTrigger,
} from "./scan-record";

const ksiCatalog = ksiCatalogJson as KsiCatalog;
const checkCatalog = checkCatalogJson as CheckCatalog;
const pin = pinJson as {
  rules: { version: string; sha256: string; path: string };
  prowler: { version: string; framework_sha256: string; framework_path: string };
};

const LIMITATIONS = [
  "Prowler 5.45.0 Apache-2.0 read-only scan. Coverage only. Not an authorization result.",
  "FedRAMP rules 2026.10.13.01 are the KSI catalog. Prowler framework text is 2026.07.14.01 and is joined by KSI id.",
  "800-53 titles come from collector-relevance.json. A person still accepts each mapping.",
  "Raw cloud responses and secret values are excluded. This collector does not call AWS write APIs.",
];

export type IngestInput = {
  target?: AccountTarget;
  findings: unknown;
  caller: CallerIdentity;
  capturedAt: string;
  trigger: ScanTrigger;
  now?: Date;
  finishedAt?: Date;
  runId?: string;
  gitCommit: string;
};

export type IngestedScan = {
  record: AwsScanRecord;
  artifacts: CollectedArtifact[];
  events: { id: string; rawEvent: string }[];
};

export function loadPinnedHashes(root = findRepoRoot()): { rules: string; framework: string } {
  const rulesPath = path.join(root, pin.rules.path);
  const frameworkPath = path.join(root, pin.prowler.framework_path);
  const rules = sha256Bytes(readFileSync(rulesPath));
  const framework = sha256Bytes(readFileSync(frameworkPath));
  if (rules !== pin.rules.sha256 || pin.rules.version !== RULES_VERSION) {
    throw new Error("Pinned FedRAMP rules file does not match catalogs/aws-reader-pin.json.");
  }
  if (framework !== pin.prowler.framework_sha256 || pin.prowler.version !== PROWLER_VERSION) {
    throw new Error("Pinned Prowler framework file does not match catalogs/aws-reader-pin.json.");
  }
  if (ksiCatalog.version !== RULES_VERSION || ksiCatalog.sha256 !== rules || ksiCatalog.ksis.length !== 46) {
    throw new Error("KSI catalog does not match the pinned FedRAMP rules file.");
  }
  return { rules, framework };
}

export function ingestProwler(input: IngestInput): IngestedScan {
  const target = accountTarget(input.target ?? GOVCLOUD_TARGET);
  const caller = input.caller;
  if (!input.target) assertCaller(caller);
  assertTargetCaller(caller, target);
  const hashes = loadPinnedHashes();
  const now = input.now ?? new Date();
  const started = now.toISOString();
  const finished = (input.finishedAt ?? now).toISOString();
  if (Date.parse(finished) < Date.parse(started)) throw new Error("AWS scan completion precedes its start.");
  const findings = parseFindings(input.findings, caller, target);
  const checks = evaluateChecks(findings, caller, target);
  checks.push(callerCheck(caller, target));
  const ksis = evaluateKsis(checks);
  const artifacts = buildArtifacts(checks, caller, input.capturedAt, target);
  if (input.trigger === "fixture") for (const artifact of artifacts) {
    artifact.limitations.push("SYNTHETIC FIXTURE adapter; no live AWS capture.");
    const {sha256: _hash, ...body} = artifact; artifact.sha256 = digest(JSON.stringify(body));
  }
  const events = collectorEvents(artifacts);
  const record = sealRecord({
    reader: { name: READER_NAME, version: READER_VERSION, git_commit: input.gitCommit },
    rules: { source: RULES_SOURCE, version: RULES_VERSION, sha256: hashes.rules },
    scanner: {
      name: "prowler",
      version: PROWLER_VERSION,
      license: PROWLER_LICENSE,
      framework: PROWLER_FRAMEWORK,
      framework_version: PROWLER_FRAMEWORK_VERSION,
    },
    run: {
      id: input.runId ?? uuidV7(now),
      started_utc: started,
      finished_utc: finished,
      started_et: etTimestamp(now),
      trigger: input.trigger,
    },
    target: {
      partition: target.partition,
      account_id: caller.Account,
      regions: [...target.regions],
      caller_arn: caller.Arn,
    },
    collector: { artifacts: artifactRefs(artifacts), events: events.map((event) => ({ id: event.id })) },
    checks,
    ksis,
    summary: summaryFromKsis(ksis),
  });
  return { record, artifacts, events };
}

type Projection = {
  check_id: string;
  region: string;
  status_code: string;
  status_detail: string;
  account_id: string;
  partition: string;
  resource_uids: string[];
  version: string;
};

function parseFindings(value: unknown, caller: CallerIdentity, target: AccountTarget): Projection[] {
  if (!Array.isArray(value)) throw new Error("Prowler output must be a JSON array of OCSF findings.");
  return value.map((item) => {
    if (!item || typeof item !== "object") throw new Error("Prowler finding is not an object.");
    const finding = item as Record<string, unknown>;
    const metadata = object(finding.metadata, "finding metadata");
    const product = object(metadata.product, "finding product");
    const cloud = object(finding.cloud, "finding cloud");
    const account = object(cloud.account, "finding account");
    const checkId = stringField(metadata.event_code, "event_code");
    const region = stringField(cloud.region, "region");
    const accountId = stringField(account.uid, "account uid");
    const version = stringField(product.version, "prowler version");
    if (version !== PROWLER_VERSION) throw new Error(`Prowler finding version ${version} is not ${PROWLER_VERSION}.`);
    if (!target.regions.includes(region) || !target.allowedAccountIds.includes(accountId)) throw new Error(`Finding region ${region} or account is outside configured target.`);
    if (accountId !== caller.Account) throw new Error("Prowler finding account does not match the caller.");
    let invalidProviderPlaceholder = false;
    const resources = Array.isArray(finding.resources) ? finding.resources : [];
    const resourceUids = resources.map((resource) => {
      const uid = stringField(object(resource, "resource").uid, "resource uid");
      const managedPolicy = new RegExp(`^arn:${target.partition}:iam::aws:policy/[A-Za-z0-9_+=,.@/-]+$`).test(uid);
      // Prowler 5.45.0's synthetic_account_kms_resource hardcodes arn:aws.
      // Preserve its no-events marker as an ERROR, never a GovCloud resource/pass.
      const placeholder = target.partition === "aws-us-gov" && finding.status_code === "MANUAL" &&
        ["kms_key_enclave_attestation_unknown_image", "kms_key_enclave_debug_attestation_detected"].includes(checkId) &&
        uid === `arn:aws:kms:${region}:${caller.Account}:enclave-debug-attestation`;
      if (placeholder) invalidProviderPlaceholder = true;
      else if (!managedPolicy && (!uid.startsWith(`arn:${target.partition}:`) || (uid.split(":")[4] && uid.split(":")[4] !== caller.Account)))
        throw new Error(`Prowler resource ARN is not in ${target.partition} or configured account.`);
      return uid;
    }).sort(compare);
    const partition = typeof cloud.partition === "string" ? cloud.partition : target.partition;
    if (partition !== target.partition) throw new Error("Finding partition mismatch.");
    return {
      check_id: checkId,
      region,
      status_code: invalidProviderPlaceholder ? "ERROR" : stringField(finding.status_code, "status_code"),
      status_detail: invalidProviderPlaceholder
        ? "Prowler emitted a wrong-partition account placeholder for missing enclave observations. This check is unavailable."
        : cleanDetail(typeof finding.status_detail === "string" ? finding.status_detail : ""),
      account_id: accountId,
      partition,
      resource_uids: resourceUids,
      version,
    };
  });
}

function evaluateChecks(findings: Projection[], caller: CallerIdentity, target: AccountTarget): ScanCheck[] {
  const byKey = new Map<string, Projection[]>();
  for (const finding of findings) {
    const key = `${finding.check_id}\0${finding.region}`;
    byKey.set(key, [...(byKey.get(key) ?? []), finding]);
  }
  const known = new Set(checkCatalog.checks.map((check) => check.check_id));
  const checks: ScanCheck[] = [];
  for (const check of checkCatalog.checks) {
    for (const region of target.regions) {
      const finding = byKey.get(`${check.check_id}\0${region}`);
      checks.push(finding ? checkFromFindings(check, finding) : missingCheck(check, region, caller, target));
    }
  }
  for (const group of byKey.values()) {
    if (!known.has(group[0].check_id)) checks.push(checkFromFindings(undefined, group, "prowler.unmapped"));
  }
  return checks;
}

/** Every resource participates; a later PASS must not erase another resource's failure. */
function checkFromFindings(check: CheckRecord | undefined, findings: Projection[], reasonOverride?: string): ScanCheck {
  if (findings.length === 1) return checkFromFinding(check, findings[0], reasonOverride);
  const priority: Record<ScanResult, number> = { error: 0, fail: 1, manual: 2, pass: 3, not_applicable: 4 };
  const sorted = [...findings].sort((a, b) =>
    priority[resultFor(check, a)] - priority[resultFor(check, b)] ||
    compare(canonicalSha256(projection(a)), canonicalSha256(projection(b))));
  const worst = checkFromFinding(check, sorted[0], reasonOverride);
  return {
    ...worst,
    evidence_excerpt: { ...worst.evidence_excerpt, status_detail: cleanDetail(`${findings.length} resource results; ${worst.evidence_excerpt.status_detail}`) },
    response_sha256: canonicalSha256(sorted.map(projection)),
  };
}

function checkFromFinding(check: CheckRecord | undefined, finding: Projection, reasonOverride?: string): ScanCheck {
  const result = resultFor(check, finding);
  const reason = reasonOverride ?? reasonFor(result, finding.status_detail);
  return {
    check_id: finding.check_id,
    region: finding.region,
    api_calls: [`prowler:${finding.check_id}`],
    result,
    reason_key: reason,
    evidence_excerpt: { status_code: finding.status_code, status_detail: finding.status_detail },
    response_sha256: canonicalSha256(projection(finding)),
  };
}

function missingCheck(check: CheckRecord, region: string, caller: CallerIdentity, target: AccountTarget): ScanCheck {
  const detail = "Prowler did not return this check.";
  const finding: Projection = {
    check_id: check.check_id,
    region,
    status_code: "MISSING",
    status_detail: detail,
    account_id: caller.Account,
    partition: target.partition,
    resource_uids: [],
    version: PROWLER_VERSION,
  };
  return {
    check_id: check.check_id,
    region,
    api_calls: [`prowler:${check.check_id}`],
    result: "error",
    reason_key: "prowler.missing",
    evidence_excerpt: { status_code: "MISSING", status_detail: detail },
    response_sha256: canonicalSha256(projection(finding)),
  };
}

function callerCheck(caller: CallerIdentity, target: AccountTarget): ScanCheck {
  const excerpt = { status_code: "PASS", status_detail: `${target.partition} ${caller.Account}` };
  return {
    check_id: "sts_get_caller_identity",
    region: target.regions[0],
    api_calls: ["sts:GetCallerIdentity"],
    result: "pass",
    reason_key: "account.allowed",
    evidence_excerpt: excerpt,
    response_sha256: canonicalSha256({ partition: target.partition, account_id: caller.Account, arn_partition: target.partition }),
  };
}

function evaluateKsis(checks: ScanCheck[]): ScanKsi[] {
  return ksiCatalog.ksis.map((ksi) => ({
    ksi_id: ksi.ksi_id,
    result: ksiResult(ksi, checks),
    check_ids: [...ksi.check_ids],
    class_variance: ksi.class_variance,
  }));
}

function ksiResult(ksi: KsiRecord, checks: ScanCheck[]): ScanResult {
  if (ksi.scope === "process" || ksi.check_ids.length === 0) return "manual";
  const ids = new Set(ksi.check_ids);
  const results = checks.filter((check) => ids.has(check.check_id)).map((check) => check.result);
  if (results.length === 0) return "error";
  if (results.some((result) => result === "error")) return "error";
  if (results.some((result) => result === "fail")) return "fail";
  if (results.every((result) => result === "not_applicable")) return "not_applicable";
  if (results.every((result) => result === "manual")) return "manual";
  if (results.some((result) => result === "pass") && results.every((result) => result === "pass" || result === "not_applicable" || result === "manual")) {
    return "pass";
  }
  return "error";
}

function buildArtifacts(checks: ScanCheck[], caller: CallerIdentity, capturedAt: string, target: AccountTarget): CollectedArtifact[] {
  return target.regions.map((region) => {
    const regional = checks.filter((check) => check.region === region).sort((a, b) => compare(a.check_id, b.check_id));
    const facts: EvidenceFact[] = regional.map((check, index) => {
      const catalogCheck = checkCatalog.checks.find((item) => item.check_id === check.check_id);
      const failed = check.result === "fail" || check.result === "error";
      return {
        key: catalogCheck?.fact_key ?? "configuration-scan",
        value: check.result,
        line: index + 1,
        field: check.check_id,
        content: `${check.check_id} = ${check.result}`,
        ...(failed ? { outcome: "fail" as const } : {}),
      };
    });
    const body = regional.map((check) => ({
      check_id: check.check_id,
      result: check.result,
      reason_key: check.reason_key,
      response_sha256: check.response_sha256,
    }));
    const sourceSha = canonicalSha256(body);
    const sourcePath = `aws-account/${region}/prowler-ocsf.json`;
    const name = `source-${digest(`${target.partition}:${caller.Account}:${region}:${sourcePath}:${sourceSha}`).slice(0, 24)}.json`;
    const safe = {
      schema: "aegis.collected-artifact.v1" as const,
      name,
      type: "AWS account scan",
      source: {
        kind: "aws-account" as const,
        account: caller.Account,
        partition: target.partition,
        region,
        path: sourcePath,
        sha256: sourceSha,
      },
      capturedAt,
      facts,
      limitations: [...LIMITATIONS],
    };
    return { ...safe, sha256: digest(JSON.stringify(safe)) };
  });
}

function resultFor(check: CheckRecord | undefined, finding: Projection): ScanResult {
  if (/access\s*denied|unauthorized|throttl|timed?\s*out|timeout/i.test(finding.status_detail)) return "error";
  const status = finding.status_code.toUpperCase();
  if (status === "MANUAL") return "manual";
  if (status === "PASS") return "pass";
  if (status === "FAIL" && check?.workload_exclusive && /no resources found/i.test(finding.status_detail)) return "not_applicable";
  if (status === "FAIL") return "fail";
  return "error";
}

function reasonFor(result: ScanResult, detail: string): string {
  if (result === "error" && /access\s*denied|unauthorized/i.test(detail)) return "prowler.access_denied";
  if (result === "error") return "prowler.error";
  if (result === "not_applicable") return "prowler.no_resources";
  if (result === "manual") return "prowler.manual";
  if (result === "pass") return "prowler.pass";
  return "prowler.fail";
}

function projection(finding: Projection): Omit<Projection, "version"> {
  return {
    check_id: finding.check_id,
    region: finding.region,
    status_code: finding.status_code,
    status_detail: finding.status_detail,
    account_id: finding.account_id,
    partition: finding.partition,
    resource_uids: finding.resource_uids,
  };
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${label}.`);
  return value as Record<string, unknown>;
}

function stringField(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Invalid ${label}.`);
  return value.trim();
}

function compare(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
