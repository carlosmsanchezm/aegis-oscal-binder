import {
  readConnectionExport,
  readConnectionExportBytes,
} from "@/lib/oscal/export-history";
import { getSession } from "@/lib/aegis";
import { withSession } from "@/lib/server/http";
import { readDocumentBundle } from "@/lib/oscal/export-artifact";
import { connectionRoute, apiJson, agentHttpError } from "@/lib/agent/http";
import { exportConnectionBundle } from "@/lib/oscal/connection-export";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(req: Request) {
  if (new URL(req.url).searchParams.has("artifact"))
    return withSession(req, async () => {
      try {
        const bytes = await readDocumentBundle(
          new URL(req.url).searchParams.get("artifact") ?? "",
        );
        return bytes
          ? new Response(Uint8Array.from(bytes).buffer, {
              headers: {
                "content-type": "application/zip",
                "cache-control": "private, no-store",
              },
            })
          : Response.json(
              { error: "Export bundle unavailable." },
              { status: 404 },
            );
      } catch (e) {
        return agentHttpError(e);
      }
    });
  return connectionRoute(req, async (a) => {
    const id = new URL(req.url).searchParams.get("export");
    if (id) {
      const record = await readConnectionExport(a.connectionId, id);
      if (!record) return apiJson({ error: "Export unavailable." }, 404);
      const bytes = await readConnectionExportBytes(record);
      if (!bytes) return apiJson({ error: "Export unavailable." }, 404);
      return new Response(Uint8Array.from(bytes).buffer, {
        headers: {
          "content-type": "application/zip",
          "content-disposition":
            "attachment; filename=binder-evidence-bundle.zip",
        },
      });
    }
    const result = await exportConnectionBundle(
      a.connectionId,
      a.sessionId,
      new URL(req.url).origin,
    );
    return new Response(Uint8Array.from(result.bytes).buffer, {
      headers: {
        "content-type": "application/zip",
        "content-disposition":
          "attachment; filename=binder-evidence-bundle.zip",
        "x-aegis-export-id": result.exportId!,
        "x-aegis-manifest-status": result.manifest.signing.status,
      },
    });
  });
}

/** Stateless companion for cookie/tab-held exports when durable storage is deliberately unset. */
export async function POST(req: Request) {
  return withSession(req, async () => {
    try {
      const { boundedBody, checkBrowserMutation } = await import(
        "@/lib/server/builder-http"
      );
      checkBrowserMutation(req);
      const { assertSchema } = await import("@/lib/oscal/validate-schema"),
        { embeddedFiles, makeBundle } = await import("@/lib/manifest/bundle");
      const body = JSON.parse(await boundedBody(req));
      assertSchema(body.document);
      const result = makeBundle([
        {
          path: "document.json",
          mediaType: "application/oscal+json",
          bytes: Buffer.from(JSON.stringify(body.document, null, 2)),
        },
        ...embeddedFiles(body.document),
      ]);
      return new Response(Uint8Array.from(result.bytes).buffer, {
        headers: {
          "content-type": "application/zip",
          "cache-control": "private, no-store",
          "x-aegis-manifest-status": result.manifest.signing.status,
        },
      });
    } catch (e) {
      return agentHttpError(e);
    }
  });
}
