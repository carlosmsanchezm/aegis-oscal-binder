import { connectionRoute, apiJson } from "@/lib/agent/http";
import { exportConnectionBundle } from "@/lib/oscal/connection-export";
import {
  readConnectionExport,
  verifyConnectionExport,
} from "@/lib/oscal/export-history";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET(req: Request) {
  return connectionRoute(req, async (a) => {
    const id = new URL(req.url).searchParams.get("export");
    if (id) {
      const record = await readConnectionExport(a.connectionId, id);
      if (!record) return apiJson({ error: "Export unavailable." }, 404);
      const verification = await verifyConnectionExport(record);
      return apiJson(
        {
          preview: false,
          export_id: id,
          manifest: record.manifest,
          verification,
        },
        verification.exitCode === 1 ? 409 : 200,
      );
    }
    const result = await exportConnectionBundle(
      a.connectionId,
      a.sessionId,
      new URL(req.url).origin,
      { retain: false },
    );
    return apiJson({
      preview: true,
      export_id: null,
      manifest: result.manifest,
    });
  });
}
