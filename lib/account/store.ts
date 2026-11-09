import { createHash, randomBytes, randomUUID } from "node:crypto";
import { AegisError } from "@/lib/aegis/errors";
import { accountKey, accountRead, accountStorageConfigured, accountWrite } from "./io";
import { cleanName, normalizeEmail } from "./text";
import {
  canCreateWorkspace,
  canManageMembers,
  isRole,
  type ClaimRecord,
  type Identity,
  type InvitationRecord,
  type OrgRecord,
  type Role,
  type UserRecord,
  type WorkspaceRecord,
} from "./types";

const SESSION_ID = /^[a-f0-9]{32}$/;
const BUILDER_OWNER = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f-]{36}$/;
const INVITE_DAYS = 14;
const MAX_MEMBERS = 100;
const MAX_PENDING = 50;
const MAX_WORKSPACES = 25;

function nowIso(): string {
  return new Date().toISOString();
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function userKey(id: string): string { return accountKey("user", `${id}.json`); }
function emailKey(email: string): string { return accountKey("email", `${sha256(email)}.json`); }
function orgKey(id: string): string { return accountKey("org", `${id}.json`); }
function orgIndexKey(userId: string): string { return accountKey("user-orgs", `${userId}.json`); }
function inviteKey(tokenHash: string): string { return accountKey("invite", `${tokenHash}.json`); }
function sessionClaimKey(sessionId: string): string { return accountKey("claim", `${sessionId}.json`); }
function builderClaimKey(ownerHash: string): string { return accountKey("claim-builder", `${ownerHash}.json`); }

function parse<T>(raw: string, check: (value: unknown) => value is T, label: string): T {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new AegisError("STORE_FAILED", `The ${label} record could not be read.`, 500); }
  if (!check(parsed)) throw new AegisError("STORE_FAILED", `The ${label} record could not be read.`, 500);
  return parsed;
}

function isUser(value: unknown): value is UserRecord {
  const user = value as UserRecord;
  return !!user && user.version === 1 && UUID.test(user.id) && typeof user.email === "string" && typeof user.name === "string"
    && (user.provider === "google" || user.provider === "microsoft");
}

function isOrg(value: unknown): value is OrgRecord {
  const org = value as OrgRecord;
  return !!org && org.version === 1 && UUID.test(org.id) && typeof org.name === "string" && Array.isArray(org.members)
    && Array.isArray(org.invitations) && Array.isArray(org.workspaces);
}

function isClaim(value: unknown): value is ClaimRecord {
  const claim = value as ClaimRecord;
  return !!claim && claim.version === 1 && UUID.test(claim.orgId) && UUID.test(claim.workspaceId);
}

async function readUser(id: string): Promise<UserRecord | null> {
  if (!UUID.test(id)) return null;
  const raw = await accountRead(userKey(id));
  return raw ? parse(raw, isUser, "user") : null;
}

export async function loadOrganization(id: string): Promise<OrgRecord | null> {
  return readOrg(id);
}

async function readOrg(id: string): Promise<OrgRecord | null> {
  if (!UUID.test(id)) return null;
  const raw = await accountRead(orgKey(id));
  return raw ? parse(raw, isOrg, "organization") : null;
}

async function mustOrg(id: string): Promise<OrgRecord> {
  const org = await readOrg(id);
  if (!org) throw new AegisError("NOT_FOUND", "That organization was not found.", 404);
  return org;
}

async function saveOrg(org: OrgRecord): Promise<void> {
  await accountWrite(orgKey(org.id), JSON.stringify(org));
}

async function orgIdsFor(userId: string): Promise<string[]> {
  const raw = await accountRead(orgIndexKey(userId));
  if (!raw) return [];
  const parsed = JSON.parse(raw) as { orgIds?: unknown };
  return Array.isArray(parsed.orgIds) ? parsed.orgIds.filter((id): id is string => typeof id === "string" && UUID.test(id)) : [];
}

async function saveOrgIds(userId: string, orgIds: string[]): Promise<void> {
  await accountWrite(orgIndexKey(userId), JSON.stringify({ version: 1, orgIds: [...new Set(orgIds)] }));
}

function memberRole(org: OrgRecord, userId: string): Role | null {
  return org.members.find((member) => member.userId === userId)?.role ?? null;
}

function adminCount(org: OrgRecord): number {
  return org.members.filter((member) => member.role === "admin").length;
}

function requireStorage(): void {
  if (!accountStorageConfigured()) throw new AegisError("STORE_UNAVAILABLE", "Account storage is not configured for this deployment.", 503);
}

export async function upsertIdentity(identity: Identity): Promise<UserRecord> {
  requireStorage();
  const email = normalizeEmail(identity.email);
  const name = cleanName(identity.name, 120) ?? email;
  if (!email || !name || !identity.subject || identity.subject.length > 200) {
    throw new AegisError("BAD_REQUEST", "The work account did not include a usable name and email.", 400);
  }
  const pointer = await accountRead(emailKey(email));
  const existingId = pointer ? (JSON.parse(pointer) as { userId?: string }).userId : null;
  const existing = existingId ? await readUser(existingId) : null;
  const now = nowIso();
  const user: UserRecord = existing
    ? { ...existing, name, provider: identity.provider, subject: identity.subject, lastActiveAt: now }
    : { version: 1, id: randomUUID(), email, name, provider: identity.provider, subject: identity.subject, createdAt: now, lastActiveAt: now };
  await accountWrite(userKey(user.id), JSON.stringify(user));
  await accountWrite(emailKey(email), JSON.stringify({ version: 1, userId: user.id }));
  return user;
}

export async function touchUser(id: string): Promise<void> {
  const user = await readUser(id);
  if (!user) return;
  user.lastActiveAt = nowIso();
  await accountWrite(userKey(user.id), JSON.stringify(user));
}

export async function getUser(id: string): Promise<UserRecord | null> {
  return readUser(id);
}

export async function organizationsFor(userId: string): Promise<OrgRecord[]> {
  const ids = await orgIdsFor(userId);
  const orgs = await Promise.all(ids.map((id) => readOrg(id)));
  return orgs.filter((org): org is OrgRecord => !!org && memberRole(org, userId) !== null);
}

export async function createOrganization(user: UserRecord, nameInput: unknown): Promise<OrgRecord> {
  requireStorage();
  const name = cleanName(nameInput, 80);
  if (!name) throw new AegisError("BAD_REQUEST", "Enter an organization name of 1 to 80 characters.", 400);
  const existing = await organizationsFor(user.id);
  if (existing.length >= 10) throw new AegisError("LIMIT", "This account has reached the organization limit.", 409);
  const now = nowIso();
  const org: OrgRecord = {
    version: 1,
    id: randomUUID(),
    name,
    createdAt: now,
    createdBy: user.id,
    members: [{ userId: user.id, role: "admin", createdAt: now }],
    invitations: [],
    workspaces: [],
  };
  await saveOrg(org);
  await saveOrgIds(user.id, [...(await orgIdsFor(user.id)), org.id]);
  return org;
}

export function publicWorkspace(workspace: WorkspaceRecord): Omit<WorkspaceRecord, "builderOwner"> {
  return {
    id: workspace.id,
    name: workspace.name,
    createdAt: workspace.createdAt,
    planningSessionId: workspace.planningSessionId,
    packageSessionId: workspace.packageSessionId,
  };
}

export function assertNoSecrets(body: unknown, org: OrgRecord | null): void {
  const text = JSON.stringify(body);
  for (const workspace of org?.workspaces ?? []) {
    if (workspace.builderOwner && text.includes(workspace.builderOwner)) {
      throw new Error("Refusing to send a boundary owner secret.");
    }
  }
}

async function writeClaim(sessionId: string, claim: ClaimRecord): Promise<void> {
  if (!SESSION_ID.test(sessionId)) throw new AegisError("BAD_REQUEST", "The browser session id is not usable.", 400);
  const existing = await readSessionClaim(sessionId);
  if (existing && (existing.orgId !== claim.orgId || existing.workspaceId !== claim.workspaceId)) {
    throw new AegisError("BOUNDARY_CLAIMED", "This browser session already belongs to a workspace.", 409);
  }
  await accountWrite(sessionClaimKey(sessionId), JSON.stringify(claim));
}

export async function readSessionClaim(sessionId: string): Promise<ClaimRecord | null> {
  if (!SESSION_ID.test(sessionId) || !accountStorageConfigured()) return null;
  const raw = await accountRead(sessionClaimKey(sessionId));
  if (!raw) return null;
  return parse(raw, isClaim, "boundary claim");
}

export async function readBuilderClaim(ownerSecret: string): Promise<ClaimRecord | null> {
  if (!BUILDER_OWNER.test(ownerSecret) || !accountStorageConfigured()) return null;
  const raw = await accountRead(builderClaimKey(sha256(ownerSecret)));
  if (!raw) return null;
  return parse(raw, isClaim, "connection claim");
}

async function ensureClaims(org: OrgRecord, workspace: WorkspaceRecord): Promise<void> {
  const claim: ClaimRecord = { version: 1, orgId: org.id, workspaceId: workspace.id };
  await writeClaim(workspace.planningSessionId, claim);
  await writeClaim(workspace.packageSessionId, claim);
  if (!BUILDER_OWNER.test(workspace.builderOwner)) throw new AegisError("STORE_FAILED", "The connection owner was not stored.", 500);
  const hash = sha256(workspace.builderOwner);
  const existing = await readBuilderClaim(workspace.builderOwner);
  if (existing && (existing.orgId !== org.id || existing.workspaceId !== workspace.id)) {
    throw new AegisError("BOUNDARY_CLAIMED", "This browser connection owner already belongs to a workspace.", 409);
  }
  await accountWrite(builderClaimKey(hash), JSON.stringify(claim));
}

export type BoundaryCookies = {
  planningSessionId: string | null;
  packageSessionId: string | null;
  builderOwner: string | null;
};

function sessionOrNew(value: string | null, claimBrowser: boolean): string {
  if (claimBrowser && value && SESSION_ID.test(value)) return value;
  return randomBytes(16).toString("hex");
}

function builderOrNew(value: string | null, claimBrowser: boolean): string {
  if (claimBrowser && value && BUILDER_OWNER.test(value)) return value;
  return randomBytes(32).toString("hex");
}

export async function createWorkspace(input: {
  orgId: string;
  userId: string;
  name: unknown;
  claimBrowser: boolean;
  cookies: BoundaryCookies;
}): Promise<WorkspaceRecord> {
  requireStorage();
  const name = cleanName(input.name, 120);
  if (!name) throw new AegisError("BAD_REQUEST", "Enter a workspace name of 1 to 120 characters.", 400);
  const org = await mustOrg(input.orgId);
  const role = memberRole(org, input.userId);
  if (!role || !canCreateWorkspace(role)) throw new AegisError("FORBIDDEN", "This role cannot create a workspace.", 403);
  if (org.workspaces.length >= MAX_WORKSPACES) throw new AegisError("LIMIT", "This organization has reached the workspace limit.", 409);
  const workspace: WorkspaceRecord = {
    id: randomUUID(),
    name,
    createdAt: nowIso(),
    planningSessionId: sessionOrNew(input.cookies.planningSessionId, input.claimBrowser),
    packageSessionId: sessionOrNew(input.cookies.packageSessionId, input.claimBrowser),
    builderOwner: builderOrNew(input.cookies.builderOwner, input.claimBrowser),
  };
  if (workspace.planningSessionId === workspace.packageSessionId) workspace.packageSessionId = randomBytes(16).toString("hex");
  for (const sessionId of [workspace.planningSessionId, workspace.packageSessionId]) {
    const existing = await readSessionClaim(sessionId);
    if (existing) throw new AegisError("BOUNDARY_CLAIMED", "This browser session already belongs to a workspace.", 409);
  }
  const existingBuilder = await readBuilderClaim(workspace.builderOwner);
  if (existingBuilder) throw new AegisError("BOUNDARY_CLAIMED", "This browser connection owner already belongs to a workspace.", 409);
  org.workspaces.push(workspace);
  await saveOrg(org);
  await ensureClaims(org, workspace);
  return workspace;
}

export async function openBoundary(orgId: string, workspaceId: string, userId: string): Promise<WorkspaceRecord> {
  const org = await mustOrg(orgId);
  const role = memberRole(org, userId);
  if (!role) throw new AegisError("FORBIDDEN", "This account is not a member of that organization.", 403);
  const workspace = org.workspaces.find((item) => item.id === workspaceId);
  if (!workspace) throw new AegisError("NOT_FOUND", "That workspace was not found.", 404);
  await ensureClaims(org, workspace);
  return workspace;
}

export async function roleForSession(sessionId: string, userId: string): Promise<Role | null> {
  const claim = await readSessionClaim(sessionId);
  if (!claim) return null;
  const org = await readOrg(claim.orgId);
  if (!org) return null;
  return memberRole(org, userId);
}

export async function roleForBuilder(ownerSecret: string, userId: string): Promise<Role | null> {
  const claim = await readBuilderClaim(ownerSecret);
  if (!claim) return null;
  const org = await readOrg(claim.orgId);
  if (!org) return null;
  return memberRole(org, userId);
}

function inviteExpiry(from = Date.now()): string {
  return new Date(from + INVITE_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

export async function createInvitation(input: {
  orgId: string;
  actorId: string;
  actorName: string;
  email: unknown;
  role: unknown;
}): Promise<{ invitation: InvitationRecord; token: string }> {
  requireStorage();
  const email = normalizeEmail(input.email);
  if (!email) throw new AegisError("BAD_REQUEST", "Enter the work email address to invite.", 400);
  if (!isRole(input.role)) throw new AegisError("BAD_REQUEST", "Choose a role for the invitation.", 400);
  const org = await mustOrg(input.orgId);
  const actor = memberRole(org, input.actorId);
  if (!actor || !canManageMembers(actor)) throw new AegisError("FORBIDDEN", "Only an admin can invite members.", 403);
  if (org.members.length >= MAX_MEMBERS) throw new AegisError("LIMIT", "This organization has reached the member limit.", 409);
  const users = await Promise.all(org.members.map((member) => readUser(member.userId)));
  if (users.some((user) => user?.email === email)) throw new AegisError("ALREADY_MEMBER", "That address is already a member.", 409);
  const pending = org.invitations.filter((invitation) => invitation.status === "pending" && Date.parse(invitation.expiresAt) > Date.now());
  if (pending.some((invitation) => invitation.email === email)) {
    throw new AegisError("INVITE_PENDING", "An invitation for that address is already pending. Resend it from the list.", 409);
  }
  if (pending.length >= MAX_PENDING) throw new AegisError("LIMIT", "This organization has too many pending invitations.", 409);
  const token = randomBytes(32).toString("base64url");
  const invitation: InvitationRecord = {
    id: randomUUID(),
    email,
    role: input.role,
    invitedBy: input.actorId,
    inviterName: input.actorName,
    createdAt: nowIso(),
    expiresAt: inviteExpiry(),
    status: "pending",
    tokenHash: sha256(token),
  };
  org.invitations.push(invitation);
  await saveOrg(org);
  await accountWrite(inviteKey(invitation.tokenHash), JSON.stringify({ version: 1, orgId: org.id, invitationId: invitation.id }));
  return { invitation, token };
}

async function invitationByToken(token: string): Promise<{ org: OrgRecord; invitation: InvitationRecord } | null> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const raw = await accountRead(inviteKey(sha256(token)));
  if (!raw) return null;
  const pointer = JSON.parse(raw) as { orgId?: string; invitationId?: string };
  if (!pointer.orgId || !pointer.invitationId) return null;
  const org = await readOrg(pointer.orgId);
  const invitation = org?.invitations.find((item) => item.id === pointer.invitationId);
  if (!org || !invitation || invitation.tokenHash !== sha256(token)) return null;
  return { org, invitation };
}

export type InvitationView = {
  state: "valid" | "expired" | "revoked" | "accepted" | "missing";
  orgId?: string;
  orgName?: string;
  role?: Role;
  inviterName?: string;
  email?: string;
};

export async function describeInvitation(token: string): Promise<InvitationView> {
  const found = await invitationByToken(token);
  if (!found) return { state: "missing" };
  const { org, invitation } = found;
  const expired = invitation.status === "pending" && Date.parse(invitation.expiresAt) <= Date.now();
  const state = expired ? "expired" : invitation.status === "pending" ? "valid" : invitation.status;
  return { state, orgId: org.id, orgName: org.name, role: invitation.role, inviterName: invitation.inviterName, email: invitation.email };
}

export async function acceptInvitation(token: string, user: UserRecord): Promise<{ org: OrgRecord; role: Role; alreadyMember: boolean }> {
  requireStorage();
  const found = await invitationByToken(token);
  if (!found) throw new AegisError("INVITE_INVALID", "This invitation is no longer valid.", 410);
  const { invitation } = found;
  let org = found.org;
  if (invitation.status === "revoked" || (invitation.status === "pending" && Date.parse(invitation.expiresAt) <= Date.now())) {
    throw new AegisError("INVITE_INVALID", "This invitation expired or was revoked. Ask an admin to send a new one.", 410);
  }
  if (user.email !== invitation.email) {
    throw new AegisError("INVITE_MISMATCH", "This invitation is for a different account.", 403, { invitedEmail: invitation.email });
  }
  const existing = memberRole(org, user.id);
  if (existing) return { org, role: existing, alreadyMember: true };
  if (invitation.status === "accepted") throw new AegisError("INVITE_INVALID", "This invitation is no longer valid.", 410);
  if (org.members.length >= MAX_MEMBERS) throw new AegisError("LIMIT", "This organization has reached the member limit.", 409);
  org.members.push({ userId: user.id, role: invitation.role, createdAt: nowIso() });
  const stored = org.invitations.find((item) => item.id === invitation.id);
  if (stored) stored.status = "accepted";
  await saveOrg(org);
  await saveOrgIds(user.id, [...(await orgIdsFor(user.id)), org.id]);
  org = await mustOrg(org.id);
  return { org, role: invitation.role, alreadyMember: false };
}

export async function changeRole(orgId: string, actorId: string, userId: string, role: unknown): Promise<OrgRecord> {
  if (!isRole(role)) throw new AegisError("BAD_REQUEST", "Choose a role.", 400);
  const org = await mustOrg(orgId);
  const actor = memberRole(org, actorId);
  if (!actor || !canManageMembers(actor)) throw new AegisError("FORBIDDEN", "Only an admin can change roles.", 403);
  if (actorId === userId) throw new AegisError("FORBIDDEN", "You cannot change your own role.", 403);
  const target = org.members.find((member) => member.userId === userId);
  if (!target) throw new AegisError("NOT_FOUND", "That member was not found.", 404);
  if (target.role === "admin" && role !== "admin" && adminCount(org) < 2) {
    throw new AegisError("LAST_ADMIN", "An organization needs at least one admin. Make another member an admin first.", 409);
  }
  target.role = role;
  await saveOrg(org);
  return org;
}

export async function removeMember(orgId: string, actorId: string, userId: string): Promise<OrgRecord> {
  const org = await mustOrg(orgId);
  const actor = memberRole(org, actorId);
  if (!actor || !canManageMembers(actor)) throw new AegisError("FORBIDDEN", "Only an admin can remove members.", 403);
  if (actorId === userId) throw new AegisError("FORBIDDEN", "You cannot remove yourself.", 403);
  const target = org.members.find((member) => member.userId === userId);
  if (!target) throw new AegisError("NOT_FOUND", "That member was not found.", 404);
  if (target.role === "admin" && adminCount(org) < 2) {
    throw new AegisError("LAST_ADMIN", "An organization needs at least one admin. Make another member an admin first.", 409);
  }
  org.members = org.members.filter((member) => member.userId !== userId);
  await saveOrg(org);
  await saveOrgIds(userId, (await orgIdsFor(userId)).filter((id) => id !== orgId));
  return org;
}

async function pendingInvitation(org: OrgRecord, invitationId: string, actorId: string): Promise<InvitationRecord> {
  const actor = memberRole(org, actorId);
  if (!actor || !canManageMembers(actor)) throw new AegisError("FORBIDDEN", "Only an admin can change invitations.", 403);
  const invitation = org.invitations.find((item) => item.id === invitationId && item.status === "pending");
  if (!invitation) throw new AegisError("NOT_FOUND", "That invitation is not pending.", 404);
  return invitation;
}

export async function revokeInvitation(orgId: string, actorId: string, invitationId: string): Promise<void> {
  const org = await mustOrg(orgId);
  const invitation = await pendingInvitation(org, invitationId, actorId);
  invitation.status = "revoked";
  await saveOrg(org);
}

export async function resendInvitation(orgId: string, actorId: string, invitationId: string): Promise<{ token: string; invitation: InvitationRecord }> {
  const org = await mustOrg(orgId);
  const invitation = await pendingInvitation(org, invitationId, actorId);
  const token = randomBytes(32).toString("base64url");
  invitation.tokenHash = sha256(token);
  invitation.expiresAt = inviteExpiry();
  invitation.createdAt = nowIso();
  await saveOrg(org);
  await accountWrite(inviteKey(invitation.tokenHash), JSON.stringify({ version: 1, orgId: org.id, invitationId: invitation.id }));
  return { token, invitation };
}

export async function memberDirectory(org: OrgRecord, you: string) {
  const users = await Promise.all(org.members.map((member) => readUser(member.userId)));
  return org.members.map((member, index) => {
    const user = users[index];
    return {
      userId: member.userId,
      name: user?.name ?? "Unknown member",
      email: user?.email ?? "",
      provider: user?.provider ?? null,
      role: member.role,
      lastActiveAt: user?.lastActiveAt ?? null,
      you: member.userId === you,
    };
  });
}

export function publicInvitations(org: OrgRecord) {
  return org.invitations
    .filter((invitation) => invitation.status === "pending")
    .map(({ tokenHash: _tokenHash, ...invitation }) => invitation);
}
