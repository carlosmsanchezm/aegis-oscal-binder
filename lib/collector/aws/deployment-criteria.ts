import type { CollectedArtifact, EvidenceFact } from "../types";

export const AWS_DEPLOYMENT_PRODUCER = "Aegis operator AWS collector v1";
/** Policy equivalences for code review, not deployed-cloud proof. */
export const AWS_IAC_CRITERIA = {
  s3_bucket_object_versioning: "CKV_AWS_21",
  ec2_securitygroup_allow_ingress_from_internet_to_tcp_port_22: "CKV_AWS_24",
} as const;
export type DeploymentCriterion = keyof typeof AWS_IAC_CRITERIA;

/** One IaC correction may cover several accounts without losing their artifacts. */
export function collectedFindingId(artifact: CollectedArtifact, fact: EvidenceFact, fallback: (path:string, field:string)=>string): string {
  return artifact.source.kind === "aws-account" && artifact.type === "Operator-linked AWS deployment checks" && fact.fixPaths?.length && fact.field in AWS_IAC_CRITERIA
    ? fallback("aws-applied-iac/" + [...fact.fixPaths].sort().join(";"), fact.field)
    : fallback(artifact.source.path, fact.field);
}
