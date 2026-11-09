import { boundaryCookies } from "@/lib/account/access";
import { assertSameOrigin } from "@/lib/account/access";
import { accountStorageMode } from "@/lib/account/io";
import { providerConfigured } from "@/lib/account/oauth";
import { accountHandler, accountJson, requireOrg, requireUser } from "@/lib/account/route";
import { authConfigured } from "@/lib/account/session";
import { createOrganization, createWorkspace, memberDirectory, organizationsFor, publicInvitations, publicWorkspace, touchUser } from "@/lib/account/store";
import { initials } from "@/lib/account/text";
import { cookieHeader, ORG_COOKIE, requestIsSecure } from "@/lib/account/session";
import { readJson } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(req: Request): Promise<Response> {
  return accountHandler(async () => {
    const { user } = await requireUser(req);
    await touchUser(user.id).catch(() => undefined);
    const orgs = await organizationsFor(user.id);
    const active = orgs.length ? await requireOrg(req, user.id).catch(() => null) : null;
    const org = active?.org ?? null;
    return accountJson({
      user: { id: user.id, email: user.email, name: user.name, provider: user.provider, initials: initials(user.name, user.email) },
      organization: org && active ? { id: org.id, name: org.name, initials: initials(org.name), role: active.role } : null,
      organizations: orgs.map((item) => ({ id: item.id, name: item.name, role: item.members.find((member) => member.userId === user.id)?.role ?? "viewer" })),
      workspaces: (org?.workspaces ?? []).map(publicWorkspace),
      members: org ? await memberDirectory(org, user.id) : [],
      invitations: org ? publicInvitations(org) : [],
      providers: { google: providerConfigured("google"), microsoft: providerConfigured("microsoft"), secret: authConfigured() },
      storage: accountStorageMode(),
    }, org);
  });
}

export function POST(req: Request): Promise<Response> {
  return accountHandler(async () => {
    assertSameOrigin(req);
    const { user } = await requireUser(req);
    const body = await readJson(req);
    if (body.kind === "workspace") {
      const { org } = await requireOrg(req, user.id);
      const workspace = await createWorkspace({
        orgId: org.id,
        userId: user.id,
        name: body.name,
        claimBrowser: body.claimBrowser !== false,
        cookies: boundaryCookies(req.headers.get("cookie")),
      });
      return accountJson({ workspace: publicWorkspace(workspace) }, { ...org, workspaces: [...org.workspaces, workspace] }, 201);
    }
    const org = await createOrganization(user, body.name);
    const response = accountJson({ organization: { id: org.id, name: org.name, role: "admin" } }, org, 201);
    response.headers.append("set-cookie", cookieHeader(ORG_COOKIE, org.id, requestIsSecure(req), 8 * 60 * 60));
    return response;
  });
}
