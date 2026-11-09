import { AccountFrame } from "@/components/account/AccountFrame";
import { SignInCard } from "@/components/account/SignInCard";
import { WorkspaceHome } from "@/components/account/WorkspaceHome";
import { providerConfigured } from "@/lib/account/oauth";
import { requireAccountPage } from "@/lib/account/page";
import { authConfigured } from "@/lib/account/session";
import { publicWorkspace } from "@/lib/account/store";
import { initials } from "@/lib/account/text";

export const dynamic = "force-dynamic";

export default async function AccountHomePage() {
  const page = await requireAccountPage("/account");
  const user = { name: page.user.name, email: page.user.email, provider: page.user.provider, role: page.role };
  if (!page.org || !page.role) {
    return <AccountFrame nav={false} build={page.build} storage={page.storage} user={user}>
      <div className="acct-center">
        <SignInCard mode="no-org" returnTo="/account" returnLabel="/account" providers={{ google: providerConfigured("google"), microsoft: providerConfigured("microsoft"), secret: authConfigured() }} user={{ ...user, initials: initials(page.user.name, page.user.email), orgName: null, role: null }} />
      </div>
    </AccountFrame>;
  }
  return <AccountFrame current="home" orgName={page.org.name} planning={page.planning} user={user} build={page.build} storage={page.storage}>
    <main className="acct-main">
      <WorkspaceHome orgName={page.org.name} role={page.role} workspaces={page.org.workspaces.map(publicWorkspace)} />
    </main>
  </AccountFrame>;
}
