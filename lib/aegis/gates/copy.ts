/** Operator-facing gate strings. Screens read this catalog; they do not invent labels. */
export const GATE_COPY = {
  limitations: {
    noAto: "No ATO, risk acceptance, or Government approval is granted by this application.",
    synthetic: "This instance uses demo planning data. It is not approved to process agency evidence.",
    releaseNotAto: "Release approval is not an authorization decision.",
    exceptionNotRisk: "An exception does not accept residual risk. Remaining risk stays on the Government official gate.",
    closureReference: "A closure reference records an external decision. It does not close the official POA&M by itself.",
    sspDraft: "SSP text stays a draft until the ISSE review and the ISSO acceptance are both recorded.",
    agentPlaceholder: "This agent run is a record only. Nothing is executed.",
  },
  reasons: {
    allowed: "Decision recorded.",
    "denied-agent": "An Aegis agent cannot approve, accept, close, or authorize.",
    "denied-role": "This role cannot take that gate action.",
    "denied-sod": "You cannot approve your own work.",
    "denied-mfa": "Step-up MFA is missing or older than the allowed window.",
    "denied-abac": "This principal is not assigned to the project or environment.",
    "denied-state": "That transition is not available from the current state.",
    "denied-fields": "Required plan fields are incomplete.",
    "denied-checks": "A failed check blocks promotion until an authorized exception covers it.",
    "denied-evidence": "Missing evidence stays unverified.",
    "denied-classification": "Record the change determination before this step.",
    "denied-external": "This application does not grant that decision.",
    "denied-ato": "Authorization stays outside Aegis. This application does not grant an ATO.",
    "denied-scope": "The agent scope is not limited to this plan.",
    "denied-secret": "A secret cannot be stored on a gate record.",
  },
  problems: {
    "confirmed-assessment": "A confirmed assessment is required before this gate.",
    weakness: "Describe the weakness.",
    asset: "Identify the affected asset.",
    control: "Identify the affected control.",
    owner: "Assign a responsible owner.",
    risk: "Document the risk rationale.",
    resources: "Identify required resources.",
    protection: "Record interim protection.",
    milestone: "Add a milestone with a description and target date.",
    justification: "Record the determination and justification.",
    scope: "Scope the agent to one repository, one branch prefix, and this plan.",
    checks: "Name the failed checks the exception covers.",
    classification: "The recorded class cannot downgrade a significant change.",
    "official-id": "The decision must reference the official POA&M ID.",
    reference: "Enter the external reference.",
    approver: "Enter the external approver. The approver is not the person recording the reference.",
    date: "Enter a valid decision date.",
    draft: "Name the SSP draft being reviewed.",
    secret: "Remove the secret and submit the reference again.",
    downgrade: "A significant change stays significant until the impact gate is recorded.",
  },
  gates: {
    "finding-validation": {
      title: "Validate the finding",
      summary: "The ISSE and the system owner decide whether tracked remediation is required.",
    },
    "plan-approval": {
      title: "Approve the plan of action",
      summary: "The ISSO approves the owner, resources, interim protection, and milestones.",
    },
    "agent-launch": {
      title: "Authorize the agent launch",
      summary: "A human authorizes one scoped, expiring launch for this item.",
    },
    "significant-change": {
      title: "Significant change",
      summary: "The ISSE records the impact analysis and the ISSO accepts it. Deployment stays paused until then.",
    },
    "merge": {
      title: "Approve merge",
      summary: "A reviewer other than the launcher approves the merge. The agent cannot approve it.",
    },
    deploy: {
      title: "Approve deploy",
      summary: "The release manager approves promotion. Release approval is not an authorization decision.",
    },
    "ssp-text": {
      title: "Accept SSP text",
      summary: "The ISSE reviews the draft and the ISSO accepts it into the package. It stays unverified until both are recorded.",
    },
    exception: {
      title: "Record an exception",
      summary: "The ISSO records an exception to a failed check. The exception is not risk acceptance.",
    },
    "risk-acceptance": {
      title: "Risk acceptance",
      summary: "A Government official may record an external risk decision. Contractors cannot accept residual risk.",
    },
    "official-closure": {
      title: "Official closure",
      summary: "The ISSO submits the evidence. The designated approval authority decides in the system of record.",
    },
    ato: {
      title: "Authorization",
      summary: "Authorization is outside Aegis. A citation does not grant an ATO.",
    },
  },
  workflow: {
    planned: "Planned",
    "finding-validated": "Finding validated",
    "plan-approved": "Plan approved",
    "agent-running": "Agent running",
    proposed: "Proposed",
    "merge-approved": "Merge approved",
    deployed: "Deployed",
    "rescan-pending": "Rescan pending",
    "ready-for-closure-review": "Ready for closure review",
    "closed-externally": "Closed externally",
    reopened: "Reopened",
  },
} as const;

export type ReasonCode = keyof typeof GATE_COPY.reasons;
export type ProblemCode = keyof typeof GATE_COPY.problems;

export function reasonText(code: ReasonCode): string {
  return GATE_COPY.reasons[code];
}

export function problemText(code: ProblemCode): string {
  return GATE_COPY.problems[code];
}
