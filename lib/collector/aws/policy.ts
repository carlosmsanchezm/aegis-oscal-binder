/** Local evaluator for the reader inline policy. It is not an AWS IAM call. */

export type PolicyDecision = "allowed" | "explicitDeny" | "implicitDeny";

type Statement = {
  Sid?: string;
  Effect: "Allow" | "Deny";
  Action?: string | string[];
  NotAction?: string | string[];
  Resource?: string | string[];
  Condition?: { StringNotEquals?: Record<string, string | string[]> };
};

export type PolicyDocument = { Version: string; Statement: Statement[] };

/** Services whose read verbs the inline policy leaves to SecurityAudit and ViewOnlyAccess. */
export const READER_SERVICES = [
  "access-analyzer", "account", "acm", "apigateway", "autoscaling", "backup", "budgets", "ce",
  "cloudformation", "cloudtrail", "config", "cur", "dlm", "dynamodb", "ec2", "ecr", "ecs",
  "elasticache", "elasticloadbalancing", "events", "guardduty", "health", "iam", "identitystore",
  "imagebuilder", "inspector2", "kms", "lambda", "logs", "monitoring", "network-firewall",
  "organizations", "ram", "rds", "resource-groups", "route53", "s3", "s3control", "secretsmanager",
  "securityhub", "shield", "signer", "sns", "sqs", "ssm", "sso", "states", "support", "tag", "wafv2",
] as const;

const READ_VERBS = ["BatchGet*", "Describe*", "Get*", "List*"];

/** Inline policy for aegis-evidence-reader. Deny wins. Managed read policies are modeled separately. */
export function readerInlinePolicy(): PolicyDocument {
  const reads = READER_SERVICES.flatMap((service) => READ_VERBS.map((verb) => `${service}:${verb}`));
  reads.push("iam:GenerateCredentialReport", "iam:GetCredentialReport", "sts:GetCallerIdentity");
  return {
    Version: "2012-10-17",
    Statement: [
      { Sid: "DenyNonRead", Effect: "Deny", NotAction: reads, Resource: "*" },
      {
        Sid: "DenyCredentialMinting",
        Effect: "Deny",
        Action: [
          "iam:CreateAccessKey", "iam:CreateLoginProfile", "iam:UpdateAccessKey", "iam:UpdateLoginProfile",
          "sts:AssumeRole", "sts:AssumeRoleWithSAML", "sts:AssumeRoleWithWebIdentity", "sts:GetFederationToken", "sts:GetSessionToken",
        ],
        Resource: "*",
      },
      {
        Sid: "DenyDataReads",
        Effect: "Deny",
        Action: [
          "s3:GetObject*", "secretsmanager:GetSecretValue", "kms:Decrypt", "kms:GenerateDataKey*",
          "ssm:GetParameter*", "logs:GetLogEvents", "logs:FilterLogEvents",
        ],
        Resource: "*",
      },
      {
        Sid: "GovCloudRegionsOnly",
        Effect: "Deny",
        NotAction: ["iam:*", "sts:*", "sso:*", "identitystore:*"],
        Resource: "*",
        Condition: { StringNotEquals: { "aws:RequestedRegion": ["us-gov-west-1", "us-gov-east-1"] } },
      },
      {
        Sid: "AllowCredentialReportAndCaller",
        Effect: "Allow",
        Action: ["iam:GenerateCredentialReport", "iam:GetCredentialReport", "sts:GetCallerIdentity"],
        Resource: "*",
      },
    ],
  };
}

export function assertExplicitServicePrefixes(policy: PolicyDocument): void {
  for (const statement of policy.Statement) {
    for (const pattern of [...list(statement.Action), ...list(statement.NotAction)]) {
      const service = pattern.split(":")[0] ?? "";
      if (!service || service.includes("*")) {
        throw new Error(`IAM action ${pattern} uses a wildcard service prefix. Use a service name such as iam:Create*.`);
      }
    }
  }
}

export function evaluatePolicy(policy: PolicyDocument, action: string, region?: string): PolicyDecision {
  let allow = false;
  for (const statement of policy.Statement) {
    if (!applies(statement, action, region)) continue;
    if (statement.Effect === "Deny") return "explicitDeny";
    if (statement.Effect === "Allow") allow = true;
  }
  return allow ? "allowed" : "implicitDeny";
}

/**
 * Inline decision, then the two attached managed policies modeled as
 * Describe/Get/List/BatchGet. SecurityAudit and ViewOnlyAccess are not
 * vendored. An inline deny still wins.
 */
export function evaluateReaderRole(policy: PolicyDocument, action: string, region?: string): PolicyDecision {
  const inline = evaluatePolicy(policy, action, region);
  if (inline !== "implicitDeny") return inline;
  const name = action.split(":")[1] ?? "";
  if (/^(Describe|Get|List|BatchGet)/.test(name)) return "allowed";
  return "implicitDeny";
}

function applies(statement: Statement, action: string, region?: string): boolean {
  const regions = statement.Condition?.StringNotEquals?.["aws:RequestedRegion"];
  if (regions) {
    const allowed = list(regions);
    if (allowed.includes(region ?? "")) return false;
  }
  if (statement.NotAction) return !list(statement.NotAction).some((pattern) => matches(pattern, action));
  if (statement.Action) return list(statement.Action).some((pattern) => matches(pattern, action));
  return false;
}

function matches(pattern: string, action: string): boolean {
  const patternParts = pattern.toLowerCase().split(":");
  const actionParts = action.toLowerCase().split(":");
  if (patternParts.length !== 2 || actionParts.length !== 2) return false;
  if (patternParts[0] !== actionParts[0]) return false;
  const expression = `^${patternParts[1].split("*").map(escapeRegex).join(".*")}$`;
  return new RegExp(expression).test(actionParts[1]);
}

function list(value: string | string[] | undefined): string[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
