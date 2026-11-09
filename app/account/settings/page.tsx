import { AccountFrame } from "@/components/account/AccountFrame";
import { SettingsPanel } from "@/components/account/SettingsHelp";
import { requireAccountPage } from "@/lib/account/page";
import { readCookie } from "@/lib/account/session";
import { memberDirectory } from "@/lib/account/store";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const page = await requireAccountPage("/account/settings");
  if (!page.org || !page.role) redirect("/account");
  const planningId = readCookie(page.header, "aegis_sa1_sid");
  const workspace = page.org.workspaces.find((item) => item.planningSessionId === planningId) ?? page.org.workspaces[0] ?? null;
  const members = await memberDirectory(page.org, page.user.id);
  const admin = members.find((member) => member.role === "admin");
  return <AccountFrame current="settings" orgName={page.org.name} planning={page.planning} user={{ name: page.user.name, email: page.user.email, provider: page.user.provider, role: page.role }} build={page.build} storage={page.storage}>
    <main className="acct-main">
      <SettingsPanel orgName={page.org.name} workspaceName={workspace?.name ?? null} pin={page.planning.pin} storage={page.storage} adminName={admin?.name ?? "No admin"} canAdmin={page.role === "admin"} />
    </main>
  </AccountFrame>;
}
