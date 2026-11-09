import { MAX_EVENT_BYTES } from "@/lib/builder/evidence";
import {reportBackendFailure} from "./backend-diagnostics";

export class BuilderRequestError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
export function builderJson(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "private, no-store", vary: "Cookie", "x-content-type-options": "nosniff" } });
}
export function checkBrowserMutation(req: Request): void {
  const origin = req.headers.get("origin");
  // Next may use its internal listening hostname in Request.url. The Host header
  // is the externally requested authority; compare parsed host including port.
  let mismatch = false;
  if (origin) {
    try { const supplied = new URL(origin); mismatch = !["http:", "https:"].includes(supplied.protocol) || supplied.host !== (req.headers.get("host") ?? new URL(req.url).host); }
    catch { mismatch = true; }
  }
  if (req.headers.get("sec-fetch-site") === "cross-site" || mismatch) throw new BuilderRequestError("Cross-origin changes are not allowed.", 403);
}
export async function boundedBody(req: Request): Promise<string> {
  const length = Number(req.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_EVENT_BYTES) throw new BuilderRequestError("Evidence event exceeds 500 KB.", 413);
  if (!req.body) throw new BuilderRequestError("JSON body required.");
  const reader = req.body.getReader(), chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_EVENT_BYTES) { await reader.cancel(); throw new BuilderRequestError("Evidence event exceeds 500 KB.", 413); }
    chunks.push(value);
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
}
export async function builderHandler(run: () => Promise<Response>): Promise<Response> {
  try { return await run(); }
  catch (error) {
    if (error instanceof BuilderRequestError) return builderJson({ ok: false, error: error.message }, error.status);
    reportBackendFailure(error);
    // Stored evidence and infrastructure errors must never become an empty/successful view.
    return builderJson({ ok: false, error: "Builder storage or retained evidence is unavailable. Retry after checking the configured store." }, 503);
  }
}
