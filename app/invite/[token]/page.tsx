import { AccountFrame } from "@/components/account/AccountFrame";
import { InviteCard } from "@/components/account/InviteCard";
import { commitLabel } from "@/lib/aegis/build";
import { accountStorageMode } from "@/lib/account/io";
import { optionalAccount } from "@/lib/account/page";
import { describeInvitation } from "@/lib/account/store";

export const dynamic = "force-dynamic";

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const view = await describeInvitation(token);
  const account = await optionalAccount();
  const alreadyMember = !!(account?.orgs.some((org) => org.id === view.orgId));
  const state = view.state === "accepted" && !alreadyMember ? "expired" : view.state;
  return <AccountFrame nav={false} build={commitLabel()} storage={accountStorageMode()} orgName={view.orgName} user={account ? { name: account.user.name, email: account.user.email, provider: account.user.provider, role: account.role } : null}>
    <div className="acct-center">
      <InviteCard
        token={token}
        state={state}
        orgName={view.orgName}
        role={view.role}
        inviterName={view.inviterName}
        invitedEmail={view.email}
        alreadyMember={alreadyMember}
        user={account ? { email: account.user.email, provider: account.user.provider } : null}
      />
    </div>
  </AccountFrame>;
}
