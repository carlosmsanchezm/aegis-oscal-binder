import { randomBytes } from "node:crypto";
import { assertSchemaId } from "../registry";
import type { CollectedArtifact } from "../types";
import { READER_NAME, READER_VERSION, RULES_SOURCE, RULES_VERSION } from "./account";
import { canonicalSha256, canonicalize } from "./jcs";
import { assertNoSecrets } from "./redact";

export const AWS_SCAN_RECORD_SCHEMA = "aegis.aws-scan-record/v1" as const;

export type ScanResult = "pass" | "fail" | "not_applicable" | "error" | "manual";
export type ScanTrigger = "github-oidc" | "local-profile" | "fixture";

export type ScanCheck = {
  check_id: string;
  region: string;
  api_calls: string[];
  result: ScanResult;
  reason_key: string;
  evidence_excerpt: { status_code: string; status_detail: string };
  response_sha256: string;
};

export type ScanKsi = {
  ksi_id: string;
  result: ScanResult;
  check_ids: string[];
  class_variance: boolean;
};

export type AwsScanRecord = {
  schema: typeof AWS_SCAN_RECORD_SCHEMA;
  reader: { name: string; version: string; git_commit: string };
  rules: { source: string; version: string; sha256: string };
  scanner: { name: "prowler"; version: string; license: string; framework: string; framework_version: string };
  run: { id: string; started_utc: string; finished_utc: string; started_et: string; trigger: ScanTrigger };
  target: { partition: string; account_id: string; regions: string[]; caller_arn: string };
  collector: {
    artifacts: { name: string; sha256: string; region: string }[];
    events: { id: string }[];
  };
  checks: ScanCheck[];
  ksis: ScanKsi[];
  summary: { pass: number; fail: number; not_applicable: number; error: number; manual: number };
  integrity: { canonicalization: "RFC 8785 JCS"; hash_alg: "sha256"; sha256: string; checks_sha256: string };
};

export function uuidV7(date = new Date()): string {
  const bytes = randomBytes(16);
  const ms = BigInt(date.getTime());
  bytes.writeUInt32BE(Number((ms >> 16n) & 0xffffffffn), 0);
  bytes.writeUInt16BE(Number(ms & 0xffffn), 4);
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function etTimestamp(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZoneName: "shortOffset",
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  const match = /^([+-])(\d{1,2})(?::(\d{2}))?$/.exec(get("timeZoneName").replace(/^GMT/, ""));
  if (!match) throw new Error("Eastern Time offset is unavailable.");
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}${match[1]}${match[2].padStart(2, "0")}:${match[3] ?? "00"}`;
}

export function checksSha256(record: Pick<AwsScanRecord, "checks" | "ksis">): string {
  return canonicalSha256({ checks: record.checks, ksis: record.ksis });
}

export function sealRecord(input: Omit<AwsScanRecord, "integrity" | "schema"> & { schema?: typeof AWS_SCAN_RECORD_SCHEMA }): AwsScanRecord {
  assertSchemaId(AWS_SCAN_RECORD_SCHEMA);
  const sorted: Omit<AwsScanRecord, "integrity"> = {
    schema: "aegis.aws-scan-record/v1",
    reader: input.reader,
    rules: input.rules,
    scanner: input.scanner,
    run: input.run,
    target: { ...input.target, regions: [...input.target.regions].sort(compare) },
    collector: {
      artifacts: [...input.collector.artifacts].sort((a, b) => compare(a.region, b.region) || compare(a.name, b.name)),
      events: [...input.collector.events].sort((a, b) => compare(a.id, b.id)),
    },
    checks: [...input.checks].sort((a, b) => compare(a.check_id, b.check_id) || compare(a.region, b.region)),
    ksis: [...input.ksis].sort((a, b) => compare(a.ksi_id, b.ksi_id)),
    summary: input.summary,
  };
  const checksHash = checksSha256(sorted);
  const sealed: AwsScanRecord = {
    ...sorted,
    integrity: { canonicalization: "RFC 8785 JCS", hash_alg: "sha256", sha256: "", checks_sha256: checksHash },
  };
  sealed.integrity.sha256 = canonicalSha256(sealed);
  assertNoSecrets(canonicalize(sealed), "Scan record");
  return sealed;
}

export function verifyRecord(record: AwsScanRecord): void {
  if (record.schema !== AWS_SCAN_RECORD_SCHEMA) throw new Error("Unsupported scan record schema.");
  assertSchemaId(record.schema);
  if (record.rules.version !== RULES_VERSION || record.rules.source !== RULES_SOURCE) {
    throw new Error("Scan record rules pin does not match the reader.");
  }
  if (record.reader.name !== READER_NAME || record.reader.version !== READER_VERSION) {
    throw new Error("Scan record reader pin does not match.");
  }
  const recomputed = canonicalSha256({ ...record, integrity: { ...record.integrity, sha256: "" } });
  if (recomputed !== record.integrity.sha256) throw new Error("Scan record integrity hash does not match.");
  if (checksSha256(record) !== record.integrity.checks_sha256) throw new Error("Scan record evidence hash does not match.");
  assertNoSecrets(canonicalize(record), "Scan record");
}

export function scanFilename(finishedUtc: string, sha256: string): string {
  const stamp = finishedUtc.replace(/-/g, "").replace(/:/g, "").replace(/\.\d{3}Z$/, "Z");
  return `scan-${stamp}-${sha256.slice(0, 12)}.json`;
}

export function recordBytes(record: AwsScanRecord): string {
  return `${canonicalize(record)}\n`;
}

export function summaryFromKsis(ksis: ScanKsi[]): AwsScanRecord["summary"] {
  const summary = { pass: 0, fail: 0, not_applicable: 0, error: 0, manual: 0 };
  for (const ksi of ksis) summary[ksi.result] += 1;
  return summary;
}

export function artifactRefs(artifacts: CollectedArtifact[]): AwsScanRecord["collector"]["artifacts"] {
  return artifacts.map((artifact) => {
    if (artifact.source.kind !== "aws-account") throw new Error("Scan artifacts must use source kind aws-account.");
    return { name: artifact.name, sha256: artifact.sha256, region: artifact.source.region };
  });
}

function compare(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
