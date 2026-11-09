import { AccountFrame } from "@/components/account/AccountFrame";
import { MembersPanel } from "@/components/account/MembersPanel";
import { requireAccountPage } from "@/lib/account/page";
import { memberDirectory, publicInvitations } from "@/lib/account/store";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function MembersPage() {
  const page = await requireAccountPage("/account/members");
  if (!page.org || !page.role) redirect("/account");
  const members = await memberDirectory(page.org, page.user.id);
  return <AccountFrame current="members" orgName={page.org.name} planning={page.planning} user={{ name: page.user.name, email: page.user.email, provider: page.user.provider, role: page.role }} build={page.build} storage={page.storage}>
    <main className="acct-main">
      <MembersPanel orgName={page.org.name} role={page.role} members={members} invitations={publicInvitations(page.org)} />
    </main>
  </AccountFrame>;
}
