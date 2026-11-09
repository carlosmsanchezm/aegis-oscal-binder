import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getPackageState } from "@/lib/aegis";
import { commitLabel } from "@/lib/aegis/build";
import { findRepoRoot } from "@/lib/aegis/paths";
import { readPlanningState } from "@/lib/server/planning-session";
import { accountStorageMode } from "./io";
import { ACCOUNT_COOKIE, openAccount, ORG_COOKIE } from "./session";
import { getUser, organizationsFor } from "./store";
import type { OrgRecord, Role, UserRecord } from "./types";
import type { AccountSession } from "./session";

export type PlanningChips = { catalog: string | null; pin: string | null; gate: string | null };

export type AccountPage = {
  header: string;
  session: AccountSession;
  user: UserRecord;
  org: OrgRecord | null;
  role: Role | null;
  orgs: OrgRecord[];
  planning: PlanningChips;
  build: string;
  storage: "blob" | "directory" | "unset";
};

async function cookieHeader(): Promise<string> {
  const jar = await cookies();
  return jar.getAll().map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}

export async function optionalAccount(): Promise<AccountPage | null> {
  const jar = await cookies();
  const header = jar.getAll().map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
  const session = await openAccount(jar.get(ACCOUNT_COOKIE)?.value ?? "");
  if (!session) return null;
  const user = await getUser(session.uid);
  if (!user) return null;
  const orgs = await organizationsFor(user.id);
  const requested = jar.get(ORG_COOKIE)?.value;
  const org = orgs.find((item) => item.id === requested) ?? orgs[0] ?? null;
  const role = org?.members.find((member) => member.userId === user.id)?.role ?? null;
  const planning: PlanningChips = { catalog: null, pin: null, gate: null };
  try {
    const pkg = getPackageState(await readPlanningState(header), { root: findRepoRoot() });
    if (pkg.loaded) planning.catalog = pkg.catalog.label;
    if (pkg.loaded && pkg.catalogPin) planning.pin = pkg.catalogPin;
    if (pkg.loaded) planning.gate = pkg.gate.label;
  } catch {
    // Account pages still render when the planning snapshot cannot be read.
  }
  return { header, session, user, org, role, orgs, planning, build: commitLabel(), storage: accountStorageMode() };
}

export async function requireAccountPage(returnTo: string): Promise<AccountPage> {
  const page = await optionalAccount();
  if (!page) redirect(`/sign-in?return=${encodeURIComponent(returnTo)}`);
  return page;
}

export { cookieHeader };
