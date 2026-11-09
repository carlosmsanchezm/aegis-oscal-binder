export const ROLES = ["admin", "isso", "system-owner", "engineer", "assessor", "viewer", "isse", "release-manager"] as const;
export type Role = (typeof ROLES)[number];
/** Human members use `Role`. An Aegis agent is a principal kind, not an invitation role. */
export const PRINCIPAL_KINDS = ["human", "aegis-agent"] as const;
export type PrincipalKind = (typeof PRINCIPAL_KINDS)[number];
export type Provider = "google" | "microsoft";

/** Actor for a gate decision. `aegis-agent` has no human role and cannot approve. */
export type Principal = {
  kind: PrincipalKind;
  id: string;
  role: Role | null;
  projects: readonly string[];
  environments: readonly string[];
  /** Assigned outside the role. Contractors leave this false. */
  governmentOfficial: boolean;
};

export type UserRecord = {
  version: 1;
  id: string;
  email: string;
  name: string;
  provider: Provider;
  subject: string;
  createdAt: string;
  lastActiveAt: string;
};

export type MemberRecord = {
  userId: string;
  role: Role;
  createdAt: string;
};

export type InvitationStatus = "pending" | "accepted" | "revoked";

export type InvitationRecord = {
  id: string;
  email: string;
  role: Role;
  invitedBy: string;
  inviterName: string;
  createdAt: string;
  expiresAt: string;
  status: InvitationStatus;
  tokenHash: string;
};

/** `builderOwner` stays in the organization file and is never copied into an API body. */
export type WorkspaceRecord = {
  id: string;
  name: string;
  createdAt: string;
  planningSessionId: string;
  packageSessionId: string;
  builderOwner: string;
};

export type OrgRecord = {
  version: 1;
  id: string;
  name: string;
  createdAt: string;
  createdBy: string;
  members: MemberRecord[];
  invitations: InvitationRecord[];
  workspaces: WorkspaceRecord[];
};

export type ClaimRecord = {
  version: 1;
  orgId: string;
  workspaceId: string;
};

export type Identity = {
  provider: Provider;
  subject: string;
  email: string;
  name: string;
};

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

export function canWriteBoundary(role: Role): boolean {
  return role === "admin" || role === "isso" || role === "system-owner" || role === "engineer";
}

export function canManageMembers(role: Role): boolean {
  return role === "admin";
}

export function canCreateWorkspace(role: Role): boolean {
  return role === "admin" || role === "isso" || role === "system-owner";
}

export function readOnlyRole(role: Role): boolean {
  return !canWriteBoundary(role);
}
