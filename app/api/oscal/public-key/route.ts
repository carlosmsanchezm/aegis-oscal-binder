import { publishedManifestKey } from "@/lib/manifest/manifest";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET() {
  try {
    const key = publishedManifestKey();
    return key
      ? Response.json(
          { status: "published", ...key },
          {
            headers: {
              "cache-control": "public, max-age=60",
              "x-content-type-options": "nosniff",
            },
          },
        )
      : Response.json(
          {
            code: "key_unavailable",
            message: "No manifest public key is published.",
          },
          { status: 503, headers: { "cache-control": "no-store" } },
        );
  } catch {
    return Response.json(
      {
        code: "key_unavailable",
        message: "The published manifest key is unavailable.",
      },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
}
