import { connectionRoute, apiJson } from "@/lib/agent/http";
import { listConnectionExports } from "@/lib/oscal/export-history";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET(req: Request) {
  return connectionRoute(req, async (a) =>
    apiJson({
      exports: (await listConnectionExports(a.connectionId)).map((r) => ({
        id: r.id,
        created_at: r.createdAt,
        signing_status: r.manifest.signing.status,
        key_id: r.manifest.signing.keyId,
        bundle_sha256: r.bundleSha256,
        manifest_url:
          "/api/oscal/manifest?connection=" +
          a.connectionId +
          "&export=" +
          r.id,
        download_url:
          "/api/oscal/bundle?connection=" + a.connectionId + "&export=" + r.id,
      })),
    }),
  );
}
