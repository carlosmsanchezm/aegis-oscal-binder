/** GovCloud account guard. The reader accepts one account and no other. */

export const ALLOWED_ACCOUNT = "111122223333";
export const REFUSED_ACCOUNTS = ["210987654321", "444455556666"] as const;
export const PARTITION = "aws-us-gov";
export const REGIONS = ["us-gov-west-1", "us-gov-east-1"] as const;
export const PRIMARY_REGION = "us-gov-west-1";

export const RULES_VERSION = "2026.10.13.01";
export const RULES_SOURCE = "FedRAMP/rules fedramp-consolidated-rules.json";
export const RULES_COMMIT = "a89d78477ddea98dc57eca24f5007794c2b4eeb6";

export const PROWLER_VERSION = "5.45.0";
export const PROWLER_LICENSE = "Apache-2.0";
export const PROWLER_SOURCE = "https://github.com/prowler-cloud/prowler";
export const PROWLER_COMMIT = "bffc8844c1c9a3666e37a2ada4ee05f62e1446b0";
export const PROWLER_FRAMEWORK = "fedramp_20x_ksi_2026";
export const PROWLER_FRAMEWORK_VERSION = "2026.07.14.01";
export const READER_NAME = "aegis-aws-reader";
export const READER_VERSION = "0.1.0";

export type GovRegion = (typeof REGIONS)[number];

export class AccountGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccountGuardError";
  }
}

export type CallerIdentity = {
  Account: string;
  Arn: string;
  UserId: string;
};

export function assertRegion(region: string): asserts region is GovRegion {
  if (!(REGIONS as readonly string[]).includes(region)) {
    throw new AccountGuardError(`Region ${region} is outside aws-us-gov regions us-gov-west-1 and us-gov-east-1.`);
  }
}

export function assertPartition(partition: string): void {
  if (partition !== PARTITION) {
    throw new AccountGuardError(`Partition ${partition} is refused. This reader accepts only ${PARTITION}.`);
  }
}

export function assertGovCloudArn(arn: string): void {
  if (!arn.startsWith("arn:aws-us-gov:")) {
    throw new AccountGuardError("Caller ARN is refused. This reader accepts only arn:aws-us-gov identities.");
  }
}

export function assertAccount(accountId: string): void {
  if (!/^\d{12}$/.test(accountId)) {
    throw new AccountGuardError("Caller account id must be 12 digits.");
  }
  if ((REFUSED_ACCOUNTS as readonly string[]).includes(accountId) || accountId !== ALLOWED_ACCOUNT) {
    throw new AccountGuardError(`Caller account ${accountId} is refused. This reader accepts only GovCloud account ${ALLOWED_ACCOUNT}.`);
  }
}

export function assertCaller(caller: CallerIdentity): void {
  assertAccount(caller.Account);
  assertGovCloudArn(caller.Arn);
  const accountInArn = /:(\d{12}):/.exec(caller.Arn)?.[1];
  if (accountInArn !== caller.Account) {
    throw new AccountGuardError("Caller ARN account does not match the caller account id.");
  }
}

export function stsEndpoint(region: string): string {
  assertRegion(region);
  // GovCloud's regional STS host is itself the AWS-listed FIPS endpoint.
  return `https://sts.${region}.amazonaws.com`;
}

export function parseCallerIdentity(value: unknown): CallerIdentity {
  if (!value || typeof value !== "object") throw new AccountGuardError("Caller identity is missing.");
  const record = value as Record<string, unknown>;
  const account = record.Account;
  const arn = record.Arn;
  const userId = record.UserId;
  if (typeof account !== "string" || typeof arn !== "string" || typeof userId !== "string") {
    throw new AccountGuardError("Caller identity is missing Account, Arn, or UserId.");
  }
  const caller = { Account: account, Arn: arn, UserId: userId };
  assertCaller(caller);
  return caller;
}

/** Explicit partition-scoped intake configuration. Never infer a partition from a profile name. */
export type AccountTarget = { partition: "aws" | "aws-us-gov"; allowedAccountIds: string[]; regions: string[] };
export const GOVCLOUD_TARGET: AccountTarget = {partition: PARTITION, allowedAccountIds: [ALLOWED_ACCOUNT], regions: [...REGIONS]};
export function accountTarget(input: AccountTarget): AccountTarget {
  if (!input || !["aws", "aws-us-gov"].includes(input.partition) || !Array.isArray(input.allowedAccountIds) || !input.allowedAccountIds.length || input.allowedAccountIds.some(id => typeof id !== "string" || !/^\d{12}$/.test(id)) || !Array.isArray(input.regions) || !input.regions.length)
    throw new AccountGuardError("Explicit partition, allowed account IDs and regions are required.");
  for (const region of input.regions) {
    if (typeof region !== "string" || (input.partition === "aws-us-gov" ? !(REGIONS as readonly string[]).includes(region) : !/^(us-(east|west)|eu-(central|north|south|west)|ap-(east|south|southeast|northeast)|ca-(central|west)|sa-east|me-(south|central)|af-south|il-central|mx-central)-[1-9]$/.test(region)))
      throw new AccountGuardError("Region does not belong to the configured partition.");
  }
  return {partition: input.partition, allowedAccountIds: [...new Set(input.allowedAccountIds)], regions: [...new Set(input.regions)]};
}
export function assertTargetCaller(caller: CallerIdentity, target: AccountTarget): void {
  const config = accountTarget(target);
  if (!caller || typeof caller.Account !== "string" || typeof caller.Arn !== "string" || typeof caller.UserId !== "string" || !caller.UserId) throw new AccountGuardError("Caller identity is missing Account, Arn, or UserId.");
  if (!config.allowedAccountIds.includes(caller.Account) || !caller.Arn.startsWith(`arn:${config.partition}:`) || caller.Arn.split(":")[4] !== caller.Account)
    throw new AccountGuardError("Caller is outside the configured account/partition boundary.");
}
