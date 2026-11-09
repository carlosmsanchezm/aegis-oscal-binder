import { assertSameOrigin } from "@/lib/account/access";
import { accountHandler, accountJson, requireOrg, requireUser } from "@/lib/account/route";
import { changeRole, memberDirectory, publicInvitations, removeMember } from "@/lib/account/store";
import { readJson } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(req: Request): Promise<Response> {
  return accountHandler(async () => {
    const { user } = await requireUser(req);
    const { org, role } = await requireOrg(req, user.id);
    return accountJson({
      role,
      canManage: role === "admin",
      members: await memberDirectory(org, user.id),
      invitations: publicInvitations(org),
    }, org);
  });
}

export function PATCH(req: Request): Promise<Response> {
  return accountHandler(async () => {
    assertSameOrigin(req);
    const { user } = await requireUser(req);
    const { org } = await requireOrg(req, user.id);
    const body = await readJson(req);
    const next = await changeRole(org.id, user.id, String(body.userId ?? ""), body.role);
    return accountJson({ members: await memberDirectory(next, user.id) }, next);
  });
}

export function DELETE(req: Request): Promise<Response> {
  return accountHandler(async () => {
    assertSameOrigin(req);
    const { user } = await requireUser(req);
    const { org } = await requireOrg(req, user.id);
    const body = await readJson(req);
    const next = await removeMember(org.id, user.id, String(body.userId ?? ""));
    return accountJson({ members: await memberDirectory(next, user.id) }, next);
  });
}
