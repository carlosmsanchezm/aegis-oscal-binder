import { assertSameOrigin } from "@/lib/account/access";
import { accountHandler, accountJson, requireOrg, requireUser } from "@/lib/account/route";
import { ORG_COOKIE, cookieHeader, publicOrigin, requestIsSecure } from "@/lib/account/session";
import { acceptInvitation, createInvitation, loadOrganization, publicInvitations, resendInvitation, revokeInvitation } from "@/lib/account/store";
import { readJson } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function link(req: Request, token: string): string {
  return `${publicOrigin(req)}/invite/${token}`;
}

export function POST(req: Request): Promise<Response> {
  return accountHandler(async () => {
    assertSameOrigin(req);
    const { user } = await requireUser(req);
    const body = await readJson(req);
    if (body.action === "accept") {
      const result = await acceptInvitation(String(body.token ?? ""), user);
      const response = accountJson({
        organization: { id: result.org.id, name: result.org.name },
        role: result.role,
        alreadyMember: result.alreadyMember,
      }, result.org);
      response.headers.append("set-cookie", cookieHeader(ORG_COOKIE, result.org.id, requestIsSecure(req), 8 * 60 * 60));
      return response;
    }
    const { org } = await requireOrg(req, user.id);
    if (body.action === "revoke") {
      await revokeInvitation(org.id, user.id, String(body.id ?? ""));
      const fresh = await loadOrganization(org.id);
      return accountJson({ invitations: publicInvitations(fresh ?? org) }, fresh ?? org);
    }
    if (body.action === "resend") {
      const sent = await resendInvitation(org.id, user.id, String(body.id ?? ""));
      return accountJson({
        invitation: { id: sent.invitation.id, email: sent.invitation.email, role: sent.invitation.role },
        link: link(req, sent.token),
        delivery: "not-built",
      }, org);
    }
    const sent = await createInvitation({ orgId: org.id, actorId: user.id, actorName: user.name, email: body.email, role: body.role });
    return accountJson({
      invitation: { id: sent.invitation.id, email: sent.invitation.email, role: sent.invitation.role, expiresAt: sent.invitation.expiresAt },
      link: link(req, sent.token),
      delivery: "not-built",
    }, org, 201);
  });
}
