import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { findRepoRoot } from "../lib/aegis/paths";
import {
  ALLOWED_ACCOUNT,
  PARTITION,
  PROWLER_COMMIT,
  PROWLER_FRAMEWORK,
  PROWLER_FRAMEWORK_VERSION,
  PROWLER_LICENSE,
  PROWLER_SOURCE,
  PROWLER_VERSION,
  REFUSED_ACCOUNTS,
  REGIONS,
  RULES_COMMIT,
  RULES_SOURCE,
  RULES_VERSION,
} from "../lib/collector/aws/account";
import { buildCatalogs, type CheckRecord } from "../lib/collector/aws/catalog";
import { sha256Bytes } from "../lib/collector/aws/jcs";
import { readerInlinePolicy } from "../lib/collector/aws/policy";

const root = findRepoRoot();
const rulesPath = "catalogs/upstream/fedramp-consolidated-rules-2026.10.13.01.json";
const frameworkPath = "catalogs/upstream/prowler-fedramp-20x-ksi-2026.json";
const rulesBytes = readFileSync(path.join(root, rulesPath));
const frameworkBytes = readFileSync(path.join(root, frameworkPath));
const rulesSha = sha256Bytes(rulesBytes);
const frameworkSha = sha256Bytes(frameworkBytes);
const built = buildCatalogs(JSON.parse(rulesBytes.toString("utf8")), JSON.parse(frameworkBytes.toString("utf8")), rulesSha);

writeJson(path.join(root, "catalogs/ksi-2026.10.13.01.json"), built.ksis);
writeJson(path.join(root, "catalogs/aws-reader-checks.json"), built.checks);
writeJson(path.join(root, "catalogs/aws-reader-pin.json"), {
  rules: { source: RULES_SOURCE, version: RULES_VERSION, commit: RULES_COMMIT, sha256: rulesSha, path: rulesPath },
  prowler: {
    name: "prowler",
    version: PROWLER_VERSION,
    license: PROWLER_LICENSE,
    source: PROWLER_SOURCE,
    commit: PROWLER_COMMIT,
    framework: PROWLER_FRAMEWORK,
    framework_version: PROWLER_FRAMEWORK_VERSION,
    framework_sha256: frameworkSha,
    framework_path: frameworkPath,
    output: "json-ocsf",
  },
  steampipe: { role: "fallback", note: "Not invoked. The AWS compliance mod covers FedRAMP Rev4, not the 46 20x KSI ids." },
  oscal_export: { planned: "compliance-trestle", status: "not-built" },
  account: { partition: PARTITION, account_id: ALLOWED_ACCOUNT, regions: REGIONS, refused_account_ids: REFUSED_ACCOUNTS },
});

const caller = {
  Account: ALLOWED_ACCOUNT,
  Arn: `arn:aws-us-gov:sts::${ALLOWED_ACCOUNT}:assumed-role/aegis-evidence-reader/fixture`,
  UserId: "AROAEXAMPLEFIXTURE:fixture",
};
for (const posture of ["empty", "hardened", "access-denied"] as const) {
  const dir = path.join(root, "fixtures/aws", posture === "access-denied" ? "access-denied" : `${posture}-account`);
  mkdirSync(dir, { recursive: true });
  writeJson(path.join(dir, "caller.json"), caller);
  writeJson(path.join(dir, "prowler.ocsf.json"), findings(built.checks.checks, posture));
  writeJson(path.join(dir, "manifest.json"), {
    posture,
    note: "Synthetic Prowler 5.45.0 JSON-OCSF shaped records. No AWS API was called.",
  });
}
mkdirSync(path.join(root, "fixtures/aws/refused-account"), { recursive: true });
writeJson(path.join(root, "fixtures/aws/refused-account/caller.json"), {
  Account: "210987654321",
  Arn: "arn:aws-us-gov:sts::210987654321:assumed-role/rejected/fixture",
  UserId: "AROAEXAMPLEFIXTURE:rejected",
});
writeJson(path.join(root, "fixtures/aws/refused-account/prowler.ocsf.json"), []);
mkdirSync(path.join(root, "infra/reader-role"), { recursive: true });
writeJson(path.join(root, "infra/reader-role/policy.json"), readerInlinePolicy());

process.stdout.write(`ksis ${built.ksis.ksis.length} checks ${built.checks.checks.length}\n`);

function findings(checks: CheckRecord[], posture: "empty" | "hardened" | "access-denied") {
  const rows = [];
  for (const check of checks) {
    for (const region of REGIONS) {
      const status = posture === "access-denied"
        ? { code: "FAIL", detail: "AccessDenied" }
        : check.workload_exclusive
          ? { code: "FAIL", detail: "No resources found in this Region." }
          : posture === "hardened"
            ? { code: "PASS", detail: "Control is met in this GovCloud account." }
            : { code: "FAIL", detail: "Control is not met in this GovCloud account." };
      rows.push({
        message: status.detail,
        metadata: {
          event_code: check.check_id,
          product: { name: "Prowler", uid: "prowler", vendor_name: "Prowler", version: PROWLER_VERSION },
          version: "1.5.0",
        },
        status_code: status.code,
        status_detail: status.detail,
        cloud: { provider: "aws", partition: PARTITION, region, account: { uid: ALLOWED_ACCOUNT } },
        resources: [{ uid: `arn:aws-us-gov:iam::${ALLOWED_ACCOUNT}:root`, region }],
      });
    }
  }
  return rows;
}

function writeJson(file: string, value: unknown): void {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}
