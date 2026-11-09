/** Data rules for routine versus significant change. A human records the determination. */
export const CLASSIFICATION_RULES = [
  {
    id: "boundary",
    impact: "significant",
    requirements: ["R02", "R04"],
    summary: "A change that touches the system or authorization boundary is significant.",
    touches: ["boundary", "authorization-boundary", "system-boundary"],
    pathPatterns: ["(?:^|[/_.-])boundary(?:[/_.-]|$)", "(?:^|[/_.-])ato-boundary(?:[/_.-]|$)"],
  },
  {
    id: "identity",
    impact: "significant",
    requirements: ["R02", "R04"],
    summary: "A change that touches identity, IAM, or RBAC is significant.",
    touches: ["identity", "iam", "rbac", "credential", "service-account"],
    pathPatterns: ["(?:^|[/_.-])identity(?:[/_.-]|$)", "(?:^|[/_.-])iam(?:[/_.-]|$)", "(?:^|[/_.-])rbac(?:[/_.-]|$)", "service-account"],
  },
  {
    id: "data",
    impact: "significant",
    requirements: ["R02", "R04"],
    summary: "A change that touches CUI, personal data, a data store, or encryption is significant.",
    touches: ["data", "cui", "pii", "data-store", "encryption"],
    pathPatterns: ["(?:^|[/_.-])cui(?:[/_.-]|$)", "(?:^|[/_.-])pii(?:[/_.-]|$)", "data-store", "data-classification", "(?:^|[/_.-])encryption(?:[/_.-]|$)"],
  },
] as const;

const COMPILED = CLASSIFICATION_RULES.map((rule) => ({
  ...rule,
  patterns: rule.pathPatterns.map((pattern) => new RegExp(pattern, "i")),
  touchSet: new Set<string>(rule.touches),
}));

export type ChangeImpact = "routine" | "significant";

export type ChangeClassification = {
  impact: ChangeImpact;
  ruleIds: string[];
  requiresGate: boolean;
  requirements: string[];
};

export function classifyChange(input: { touches?: readonly string[]; paths?: readonly string[] }): ChangeClassification {
  const touches = new Set((input.touches ?? []).map((item) => item.trim().toLowerCase()).filter(Boolean));
  const paths = input.paths ?? [];
  const matched = COMPILED.filter((rule) => {
    if ([...touches].some((touch) => rule.touchSet.has(touch))) return true;
    return paths.some((file) => rule.patterns.some((pattern) => pattern.test(file)));
  });
  if (!matched.length) {
    return { impact: "routine", ruleIds: [], requiresGate: false, requirements: ["R03", "R04"] };
  }
  return {
    impact: "significant",
    ruleIds: matched.map((rule) => rule.id),
    requiresGate: true,
    requirements: ["R02", "R04"],
  };
}
