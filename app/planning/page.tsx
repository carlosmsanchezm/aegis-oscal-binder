import { cookies } from "next/headers";
import { BinderShell } from "@/components/BinderShell";
import { commitLabel } from "@/lib/aegis/build";
import { findRepoRoot, getPackageState } from "@/lib/aegis";
import { moderateRollupShell } from "@/lib/aegis/rollup-shell";
import { releaseScreenSeed } from "@/lib/server/pipeline-inbound";
import { readPlanningState } from "@/lib/server/planning-session";

export const dynamic = "force-dynamic";
export default async function PlanningPage() {
  const jar = await cookies();
  const rawCookies = jar.getAll().map(cookie => `${cookie.name}=${cookie.value}`).join("; ");
  const root = findRepoRoot();
  return <BinderShell initial={getPackageState(await readPlanningState(rawCookies), { root })} buildCommit={commitLabel()} sa1Demo pipelineSeed={await releaseScreenSeed()} rollupShell={moderateRollupShell(root)} />;
}
