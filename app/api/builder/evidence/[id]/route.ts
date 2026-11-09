import { evidenceSource } from "@/lib/aegis/evidence-source";
import { readSessionId } from "@/lib/aegis/store";
import {
  builderOwner,
  ownsConnection,
  readBundle,
  readConnection,
} from "@/lib/server/builder-store";
import {
  builderHandler,
  builderJson,
  BuilderRequestError,
} from "@/lib/server/builder-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return builderHandler(async () => {
    const { id } = await context.params,
      connectionId = new URL(req.url).searchParams.get("connection") ?? "";
    if (!/^[0-9a-f-]{36}$/.test(connectionId) || !/^[a-f0-9]{64}$/.test(id))
      throw new BuilderRequestError("Evidence not found.", 404);
    const connection = await readConnection(connectionId);
    if (
      !connection ||
      !ownsConnection(connection, builderOwner(req.headers.get("cookie")))
    )
      throw new BuilderRequestError("Evidence not found.", 404);
    const bundle = await readBundle(connectionId, id);
    if (!bundle) throw new BuilderRequestError("Evidence not found.", 404);
    const source_label = await evidenceSource(
      readSessionId(req.headers.get("cookie")),
      connectionId,
      id,
    );
    const artifactName = new URL(req.url).searchParams.get("artifact");
    if (artifactName !== null) {
      const artifact = bundle.event.artifacts.find(
        (a) => a.name === artifactName,
      );
      if (!artifact) throw new BuilderRequestError("Artifact not found.", 404);
      // Always download bytes. Producer-supplied HTML must never execute on Binder's origin.
      return new Response(Buffer.from(artifact.contentBase64, "base64"), {
        headers: {
          "x-aegis-source": source_label.kind,
          "content-type": "application/octet-stream",
          "cache-control": "private, no-store",
          "x-content-type-options": "nosniff",
          "content-disposition": `attachment; filename="${artifact.name}"`,
        },
      });
    }
    const response = builderJson({
      ...bundle,
      source_label,
      items: bundle.event.artifacts.map((a) => ({
        name: a.name,
        sha256: a.sha256,
        source_label,
      })),
    });
    response.headers.set(
      "content-disposition",
      `attachment; filename="evidence-${id}.json"`,
    );
    return response;
  });
}
