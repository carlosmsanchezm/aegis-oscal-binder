import { cookies } from "next/headers";
import { SESSION_COOKIE, emptyPersisted, findRepoRoot, getPackageState, peekPersisted } from "@/lib/aegis";
import { commitLabel } from "@/lib/aegis/build";
import type { M1Header } from "@/components/m1/M1Chrome";
import type { Workspace } from "@/lib/m1/api";
import { readPlanningState } from "./planning-session";

export type M1PageContext = { workspace: Workspace; header: M1Header; buildSha: string };

/** Header values come from the package state of the session the user came from. */
export async function m1PageContext(query: { workspace?: string }): Promise<M1PageContext> {
  const workspace: Workspace = query.workspace === "sa1-demo" ? "planning" : "classic";
  const jar = await cookies();
  const root = findRepoRoot();
  let header: M1Header = null;
  try {
    const persisted = workspace === "planning"
      ? await readPlanningState(jar.getAll().map((cookie) => `${cookie.name}=${cookie.value}`).join("; "), root)
      : (await peekPersisted(jar.get(SESSION_COOKIE)?.value)) ?? emptyPersisted();
    const pkg = getPackageState(persisted, { root });
    if (pkg.loaded) {
      header = {
        workspaceName: pkg.workspaceName ?? "Unnamed workspace",
        catalog: pkg.catalog.label,
        pin: pkg.catalogPin,
        gate: { status: pkg.gate.status, incomplete: pkg.gate.incomplete, total: pkg.gate.total },
      };
    }
  } catch {
    header = null;
  }
  return { workspace, header, buildSha: commitLabel() };
}
