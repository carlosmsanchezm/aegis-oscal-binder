import { evidenceSource } from "@/lib/aegis/evidence-source";
import { readSessionId } from "@/lib/aegis/store";
import { latestChecks } from "@/lib/builder/evidence";
import {
  summarizeBuilderBundle,
  sourcedBuilderBundle,
} from "@/lib/server/builder-observation";
import {
  BUILDER_COOKIE,
  builderOwner,
  createConnection,
  listBundles,
  listConnections,
} from "@/lib/server/builder-store";
import { builderMutationDenial } from "@/lib/account/access";
import {
  boundedBody,
  builderHandler,
  builderJson,
  BuilderRequestError,
  checkBrowserMutation,
} from "@/lib/server/builder-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  return builderHandler(async () => {
    const connections = await listConnections(
      builderOwner(req.headers.get("cookie")),
    );
    const summaries = await Promise.all(
      connections.map(async (c) => {
        const bundles = await listBundles(c.id);
        const sources = new Map(
          await Promise.all(
            bundles.map(
              async (b) =>
                [
                  b.id,
                  await evidenceSource(
                    readSessionId(req.headers.get("cookie")),
                    c.id,
                    b.id,
                  ),
                ] as const,
            ),
          ),
        );
        const sessionId = readSessionId(req.headers.get("cookie"));
        const releaseEvidence = sessionId ? await (await import("@/lib/server/release-evidence")).releaseEvidenceFor(sessionId, c.id) : [];
        const runner = await import("@/lib/agent/fix-runner");
        let fixProgress = null;
        if (sessionId && c.github && !c.revokedAt && runner.runnerEnabled()) {
          try {
            const cloudProof=releaseEvidence.some(b=>b.items.some(i=>i.retestResult==="pass"&&i.retestReceiptId&&i.retestReceiptId!==b.releaseSha256)) ?
              await (await import("@/lib/collector/trusted-release")).trustedReleases(sessionId,c.id) : [];
            fixProgress = (await import("@/lib/aegis/fix-progress")).fixProgress((await runner.getFixRunner(sessionId, c.id)).assignments, releaseEvidence,cloudProof);
          }
          catch { /* Unavailable runner metadata cannot hide other connections or claim completion. */ }
        }
        return {
          ...(fixProgress ? {fixProgress} : {}),
          ...(readSessionId(req.headers.get("cookie")) ? {releaseEvidence: releaseEvidence} : {}),
          id: c.id,
          name: c.name,
          createdAt: c.createdAt,
          revokedAt: c.revokedAt ?? null,
          checks: latestChecks(bundles).map(
            ({ bundle, check, state, previous }) => ({
              check,
              state,
              source_label: sources.get(bundle.id),
              evidenceId: bundle.id,
              subject: bundle.event.subject,
              run: bundle.event.run,
              previousId: previous?.id ?? null,
              previousVerdict:
                previous?.event.checks.find((p) => p.id === check.id)
                  ?.verdict ?? null,
            }),
          ),
          history: bundles.map((b) =>
            sourcedBuilderBundle(b, sources.get(b.id)!),
          ),
        };
      }),
    );
    return builderJson({ ok: true, connections: summaries, ...((await import("@/lib/agent/fix-runner")).runnerEnabled() ? {refreshIntervalMs:3000} : {}) });
  });
}

export async function POST(req: Request): Promise<Response> {
  return builderHandler(async () => {
    checkBrowserMutation(req);
    const denied = await builderMutationDenial(req);
    if (denied) throw new BuilderRequestError(denied.message, denied.status);
    let name: unknown;
    try {
      name = (JSON.parse(await boundedBody(req)) as Record<string, unknown>)
        ?.name;
    } catch (error) {
      if (error instanceof BuilderRequestError) throw error;
      throw new BuilderRequestError("System name required.");
    }
    if (
      typeof name !== "string" ||
      !name.trim() ||
      name.length > 100 ||
      /[\u0000-\u001f]/.test(name)
    )
      throw new BuilderRequestError(
        "Use a system name between 1 and 100 characters.",
      );
    const owner = builderOwner(req.headers.get("cookie"));
    if ((await listConnections(owner)).length >= 10)
      throw new BuilderRequestError(
        "Pilot workspace supports up to ten connections.",
        409,
      );
    const created = await createConnection(name, owner);
    const response = builderJson(
      {
        ok: true,
        connection: {
          id: created.connection.id,
          name: created.connection.name,
        },
        token: created.token,
      },
      201,
    );
    if (!owner)
      response.headers.append(
        "set-cookie",
        `${BUILDER_COOKIE}=${created.owner}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000${new URL(req.url).protocol === "https:" ? "; Secure" : ""}`,
      );
    return response;
  });
}
