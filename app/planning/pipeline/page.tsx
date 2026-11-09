import { cookies } from "next/headers";
import { BinderShell } from "@/components/BinderShell";
import { commitLabel } from "@/lib/aegis/build";
import { emptyPersisted, findRepoRoot, getPackageState, peekPersisted } from "@/lib/aegis";
import { SA1_COOKIE } from "@/lib/aegis/sa1-demo";
import { moderateRollupShell } from "@/lib/aegis/rollup-shell";
import { releaseScreenSeed } from "@/lib/server/pipeline-inbound";

export const dynamic = "force-dynamic";
export default async function PipelinePage() {
  const jar = await cookies();
  const persisted = (await peekPersisted(jar.get(SA1_COOKIE)?.value)) ?? emptyPersisted();
  const root = findRepoRoot();
  return <BinderShell initial={getPackageState(persisted, { root })} buildCommit={commitLabel()} sa1Demo initialView="release" pipelineSeed={await releaseScreenSeed()} rollupShell={moderateRollupShell(root)} />;
}
