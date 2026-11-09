export const WORKFLOW_SCOPES = [
  "read_findings",
  "draft_poam",
  "propose_triage",
  "request_retest",
  "propose_fix_pr",
  "request_closure_review",
] as const;
export type WorkflowScope = (typeof WORKFLOW_SCOPES)[number];
export const SCOPE_ALIASES = {
  read: "read_findings",
  draft: "draft_poam",
  triage: "propose_triage",
  retest: "request_retest",
  fix_pr: "propose_fix_pr",
  close: "request_closure_review",
} as const;
export type AgentScope = WorkflowScope | keyof typeof SCOPE_ALIASES;
export const AGENT_SCOPES = [
  ...WORKFLOW_SCOPES,
  ...Object.keys(SCOPE_ALIASES),
] as readonly AgentScope[];
export function workflowScope(scope: string): WorkflowScope | undefined {
  if ((WORKFLOW_SCOPES as readonly string[]).includes(scope))
    return scope as WorkflowScope;
  return Object.hasOwn(SCOPE_ALIASES, scope)
    ? SCOPE_ALIASES[scope as keyof typeof SCOPE_ALIASES]
    : undefined;
}
export function hasAgentScope(
  token: { scopes: readonly string[] },
  scope: AgentScope,
) {
  const wanted = workflowScope(scope);
  return !!wanted && token.scopes.some((s) => workflowScope(s) === wanted);
}
