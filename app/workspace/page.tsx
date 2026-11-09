import PlanningPage from "../planning/page";
import { cookies } from "next/headers";
import { BinderShell } from "@/components/BinderShell";
import { commitLabel } from "@/lib/aegis/build";
import { SESSION_COOKIE, emptyPersisted, findRepoRoot, getPackageState, peekPersisted } from "@/lib/aegis";

export const dynamic = "force-dynamic";

/** Preserve the package editor alongside the planning home page. */
export default async function WorkspacePage({ searchParams }: { searchParams: Promise<{ workspace?: string; editor?: string }> }) {
  const query = await searchParams;
  if (query.editor !== "classic") return PlanningPage();
  const jar = await cookies();
  const persisted = (await peekPersisted(jar.get(SESSION_COOKIE)?.value)) ?? emptyPersisted();
  const initial = getPackageState(persisted, { root: findRepoRoot() });
  return <BinderShell initial={initial} buildCommit={commitLabel()} />;
}
