import type { ReactNode } from "react";
import Link from "next/link";
import { AccountFooter, AccountMark, AccountMenu } from "./AccountBits";
import { initials } from "@/lib/account/text";
import type { Provider, Role } from "@/lib/account/types";
import "./account.css";

const TABS = [
  ["Package map", "/planning"],
  ["Release evidence", "/planning?view=release"],
  ["Export flow", "/planning?view=export"],
  ["Changes", "/planning?view=changes"],
  ["System connections", "/planning?view=connections"],
] as const;

export function AccountFrame({
  children,
  nav = true,
  current,
  orgName,
  planning,
  user,
  build,
  storage,
}: {
  children: ReactNode;
  nav?: boolean;
  current?: "members" | "settings" | "help" | "home";
  orgName?: string | null;
  planning?: { catalog: string | null; pin: string | null; gate: string | null };
  user?: { name: string; email: string; provider: Provider; role: Role | null } | null;
  build: string;
  storage: "blob" | "directory" | "unset";
}) {
  return <div className="acct">
    <header className="acct-top">
      <AccountMark />
      <div className="acct-brand">OSCAL binder</div>
      {orgName && <div className="acct-org" aria-label={orgName}><span className="acct-mark">{initials(orgName)}</span><b>{orgName}</b><span aria-hidden="true">/</span></div>}
      {planning?.catalog && <div className="acct-chip">Catalog <b>{planning.catalog}</b></div>}
      {planning?.pin && <div className="acct-chip">Pin <b>{planning.pin}</b> <span>read only</span></div>}
      {planning?.gate && <div className="acct-chip">Completeness <b>{planning.gate}</b></div>}
      <span className="spacer" />
      {user && <AccountMenu name={user.name} email={user.email} provider={user.provider} role={user.role} org={orgName ?? null} />}
    </header>
    {nav && <nav className="acct-nav" aria-label="Account">
      {TABS.map(([label, href]) => <Link key={label} href={href}>{label}</Link>)}
      <Link href="/account/members" aria-current={current === "members" ? "page" : undefined}>Organization and members</Link>
      <Link href="/account/settings" aria-current={current === "settings" ? "page" : undefined}>Settings</Link>
      <Link href="/account/help" aria-current={current === "help" ? "page" : undefined}>Help</Link>
    </nav>}
    {children}
    <AccountFooter build={build} storage={storage} />
  </div>;
}
