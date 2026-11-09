import { PROWLER_FRAMEWORK, PROWLER_FRAMEWORK_VERSION, PROWLER_VERSION, RULES_SOURCE, RULES_VERSION } from "./account";

/** KSIs whose automated checks describe a deployed workload. An empty account reports them not_applicable. */
export const WORKLOAD_KSIS = ["KSI-CNA-OFA", "KSI-CNA-RVP", "KSI-SVC-VCM"] as const;

const FACT_KEYS = new Set([
  "configuration-scan",
  "log-config",
  "monitor-config",
  "network-policy",
  "rbac",
  "secret-reference",
  "service-account",
  "tls-config",
  "vulnerability-scan",
  "workload",
]);

export type KsiRecord = {
  ksi_id: string;
  name: string;
  family: string;
  family_name: string;
  statement: string;
  class_variance: boolean;
  class_b_statement: string | null;
  controls: string[];
  scope: "account" | "workload" | "process";
  check_ids: string[];
  scanner_check_ids: string[];
};

export type CheckRecord = {
  check_id: string;
  ksi_ids: string[];
  rollup_ksi_ids: string[];
  fact_key: string;
  workload_exclusive: boolean;
  scope: "account" | "workload";
};

export type KsiCatalog = {
  source: string;
  version: string;
  sha256: string;
  ksis: KsiRecord[];
};

export type CheckCatalog = {
  scanner: "prowler";
  scanner_version: string;
  framework: string;
  framework_version: string;
  checks: CheckRecord[];
};

type RulesFile = {
  info?: { version?: string };
  KSI?: Record<string, { id?: string; name?: string; indicators?: Record<string, Indicator> }>;
};

type Indicator = {
  name?: string;
  statement?: string;
  controls?: string[];
  varies_by_class?: { b?: { statement?: string }; c?: { statement?: string } };
};

type ProwlerFile = {
  version?: string;
  requirements?: { id?: string; checks?: { aws?: string[] } }[];
};

export function factKeyForCheck(checkId: string): string {
  if (/^(cloudtrail_|cloudwatch_)/.test(checkId)) return "log-config";
  if (/^(iam_|sso_|identitystore_|account_)/.test(checkId)) return "service-account";
  if (/^(kms_|acm_)/.test(checkId)) return "tls-config";
  if (/^(guardduty_|securityhub_|detective_|macie2?_)/.test(checkId)) return "monitor-config";
  if (/^accessanalyzer_/.test(checkId)) return "rbac";
  if (/^(inspector2_|inspector_|ecr_)/.test(checkId)) return "vulnerability-scan";
  if (/^(secretsmanager_|ssm_)/.test(checkId)) return "secret-reference";
  if (/^(ecs_|elb_|elbv2_|elasticloadbalancing_)/.test(checkId)) return "workload";
  if (/^(s3_|ec2_|vpc_|waf_|wafv2_|networkfirewall_)/.test(checkId)) return "network-policy";
  return "configuration-scan";
}

export function buildCatalogs(rules: unknown, prowler: unknown, rulesSha256: string): { ksis: KsiCatalog; checks: CheckCatalog } {
  const rulesFile = rules as RulesFile;
  if (rulesFile.info?.version !== RULES_VERSION) {
    throw new Error(`FedRAMP rules version ${String(rulesFile.info?.version)} is not ${RULES_VERSION}.`);
  }
  const indicators = new Map<string, { family: string; familyName: string; indicator: Indicator }>();
  for (const family of Object.values(rulesFile.KSI ?? {})) {
    for (const [id, indicator] of Object.entries(family.indicators ?? {})) {
      indicators.set(id, { family: String(family.id), familyName: String(family.name), indicator });
    }
  }
  if (indicators.size !== 46) throw new Error(`Expected 46 KSIs and found ${indicators.size}.`);

  const prowlerFile = prowler as ProwlerFile;
  if (prowlerFile.version !== PROWLER_FRAMEWORK_VERSION) {
    throw new Error(`Prowler framework version ${String(prowlerFile.version)} is not ${PROWLER_FRAMEWORK_VERSION}.`);
  }
  const byKsi = new Map<string, string[]>();
  for (const requirement of prowlerFile.requirements ?? []) {
    if (!requirement.id || !indicators.has(requirement.id)) throw new Error(`Prowler requirement ${String(requirement.id)} is not in the rules catalog.`);
    byKsi.set(requirement.id, [...(requirement.checks?.aws ?? [])].sort(compare));
  }
  if (byKsi.size !== 46) throw new Error(`Expected 46 Prowler requirements and found ${byKsi.size}.`);

  const ksiIdsForCheck = new Map<string, string[]>();
  for (const [ksiId, checkIds] of byKsi) {
    for (const checkId of checkIds) {
      const list = ksiIdsForCheck.get(checkId) ?? [];
      list.push(ksiId);
      ksiIdsForCheck.set(checkId, list);
    }
  }

  const checks: CheckRecord[] = [...ksiIdsForCheck.entries()].sort((a, b) => compare(a[0], b[0])).map(([checkId, ksiIds]) => {
    const sorted = [...ksiIds].sort(compare);
    const workloadExclusive = sorted.every((id) => (WORKLOAD_KSIS as readonly string[]).includes(id));
    const factKey = factKeyForCheck(checkId);
    if (!FACT_KEYS.has(factKey)) throw new Error(`Fact key ${factKey} is not in collector-relevance.json.`);
    return {
      check_id: checkId,
      ksi_ids: sorted,
      rollup_ksi_ids: sorted.filter((id) => !(WORKLOAD_KSIS as readonly string[]).includes(id) || workloadExclusive),
      fact_key: factKey,
      workload_exclusive: workloadExclusive,
      scope: workloadExclusive ? "workload" : "account",
    };
  });

  const ksis: KsiRecord[] = [...indicators.entries()].sort((a, b) => compare(a[0], b[0])).map(([id, entry]) => {
    const scannerCheckIds = byKsi.get(id) ?? [];
    const exclusive = scannerCheckIds.filter((checkId) => checks.find((item) => item.check_id === checkId)?.workload_exclusive);
    const workload = (WORKLOAD_KSIS as readonly string[]).includes(id);
    const statement = entry.indicator.statement
      ?? entry.indicator.varies_by_class?.c?.statement
      ?? entry.indicator.varies_by_class?.b?.statement
      ?? "";
    if (!statement || !entry.indicator.name) throw new Error(`KSI ${id} is missing a name or statement.`);
    return {
      ksi_id: id,
      name: entry.indicator.name,
      family: entry.family,
      family_name: entry.familyName,
      statement,
      class_variance: Boolean(entry.indicator.varies_by_class),
      class_b_statement: entry.indicator.varies_by_class?.b?.statement ?? null,
      controls: [...(entry.indicator.controls ?? [])],
      scope: scannerCheckIds.length === 0 ? "process" : workload ? "workload" : "account",
      check_ids: workload ? exclusive : scannerCheckIds,
      scanner_check_ids: scannerCheckIds,
    };
  });

  return {
    ksis: { source: RULES_SOURCE, version: RULES_VERSION, sha256: rulesSha256, ksis },
    checks: {
      scanner: "prowler",
      scanner_version: PROWLER_VERSION,
      framework: PROWLER_FRAMEWORK,
      framework_version: PROWLER_FRAMEWORK_VERSION,
      checks,
    },
  };
}

function compare(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
