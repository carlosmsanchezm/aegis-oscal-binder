import { AccountFrame } from "@/components/account/AccountFrame";
import { SignInCard } from "@/components/account/SignInCard";
import { commitLabel } from "@/lib/aegis/build";
import { accountStorageMode } from "@/lib/account/io";
import { optionalAccount } from "@/lib/account/page";
import { providerConfigured } from "@/lib/account/oauth";
import { authConfigured } from "@/lib/account/session";
import { initials, safeReturn } from "@/lib/account/text";

export const dynamic = "force-dynamic";

type Query = Record<string, string | string[] | undefined>;

function one(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

export default async function SignInPage({ searchParams }: { searchParams: Promise<Query> }) {
  const query = await searchParams;
  const returnTo = safeReturn(one(query.return), "/account");
  const account = await optionalAccount();
  const error = one(query.error);
  const notice = one(query.notice);
  const reason = one(query.reason);
  let mode: "buttons" | "signed-in" | "no-org" | "expired" | "failed" | "personal" | "unverified" | "configuration" = "buttons";
  if (error === "configuration") mode = "configuration";
  else if (error === "personal") mode = "personal";
  else if (error === "unverified") mode = "unverified";
  else if (error === "cancelled" || error === "failed") mode = "failed";
  else if (account && (!account.org || notice === "no-org")) mode = "no-org";
  else if (reason === "expired" && !account) mode = "expired";
  else if (account) mode = "signed-in";
  const workspace = account?.org?.workspaces[0]?.name;
  const returnLabel = workspace && returnTo.startsWith("/planning") ? `${workspace} · ${returnTo}` : returnTo;
  return <AccountFrame nav={false} build={commitLabel()} storage={accountStorageMode()} user={account ? { name: account.user.name, email: account.user.email, provider: account.user.provider, role: account.role } : null} orgName={account?.org?.name}>
    <div className="acct-center">
      <SignInCard
        mode={mode}
        returnTo={returnTo}
        returnLabel={returnLabel}
        providers={{ google: providerConfigured("google"), microsoft: providerConfigured("microsoft"), secret: authConfigured() }}
        user={account ? { name: account.user.name, email: account.user.email, provider: account.user.provider, initials: initials(account.user.name, account.user.email), orgName: account.org?.name, role: account.role } : null}
      />
    </div>
  </AccountFrame>;
}
