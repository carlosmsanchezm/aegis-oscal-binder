import type { SourceKind } from "./registry";

/** Safe derived evidence. Raw source and secret values are never retained. */
export type EvidenceFact = {
  key: string; value: string | number | boolean; line: number; field: string; content: string;
  outcome?: "fail";
  /** Explicit scanner remediation scope; absent scope reserves the repository conservatively. */
  fixPaths?: string[];
  resourceIds?: string[];
  /** FedRAMP 20x Key Security Indicator, when the collector observed one. Uppercase, for example `KSI-IAM`. */
  ksi?: string;
};

export type GitArtifactSource = {
  repo: string;
  commit: string;
  path: string;
  sha256: string;
  kind?: "scan-result" | "release-asset";
  url?: string;
};

/** Partition-scoped AWS account capture. Account, partition, and region stand in for a git repo and commit. */
export type AwsAccountSource = {
  kind: "aws-account";
  /** Absent: an account capture has no git repo or commit. Typed so repo-only consumers stay valid. */
  repo?: undefined;
  commit?: undefined;
  url?: undefined;
  account: string;
  partition: string;
  region: string;
  path: string;
  sha256: string;
};

export type CollectedArtifact = {
  schema: "aegis.collected-artifact.v1";
  name: string;
  type: string;
  source: GitArtifactSource | AwsAccountSource;
  capturedAt: string;
  sha256: string;
  facts: EvidenceFact[];
  limitations: string[];
};

export type GitEvidenceSource = {
  repo: string;
  commit: string;
  path: string;
  content: string;
  capturedAt: string;
  sourceKind?: "scan-result" | "release-asset";
  sourceUrl?: string;
};

export type AwsEvidenceSource = {
  sourceKind: "aws-account";
  account: string;
  partition: string;
  region: string;
  path: string;
  content: string;
  capturedAt: string;
};

export type EvidenceSource = GitEvidenceSource | AwsEvidenceSource;

export function isAwsAccountSource(source: CollectedArtifact["source"]): source is AwsAccountSource {
  return source.kind === "aws-account";
}

export type { SourceKind };
