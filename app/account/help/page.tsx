import { AccountFrame } from "@/components/account/AccountFrame";
import { HelpPanel } from "@/components/account/SettingsHelp";
import { requireAccountPage } from "@/lib/account/page";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function HelpPage() {
  const page = await requireAccountPage("/account/help");
  if (!page.org || !page.role) redirect("/account");
  return <AccountFrame current="help" orgName={page.org.name} planning={page.planning} user={{ name: page.user.name, email: page.user.email, provider: page.user.provider, role: page.role }} build={page.build} storage={page.storage}>
    <main className="acct-main">
      <HelpPanel build={page.build} />
    </main>
  </AccountFrame>;
}
