import { PIPELINE_WEBHOOK_HEADER, PIPELINE_WEBHOOK_PATH } from "@/lib/aegis/pipeline-inbound";
import { persistenceMode, storageUnconfigured } from "@/lib/durable";
import {
  acceptPipelineEvent,
  pipelineWebhookSecret,
  readSelectedRelease,
  readReleaseHistory,
  writeSelectedRelease,
} from "@/lib/server/pipeline-inbound";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY = 512_000;

function reject(status: number, code: string, message: string): Response {
  return Response.json(
    { ok: false, error: { code, message, details: null } },
    { status, headers: { "cache-control": "private, no-store" } },
  );
}

export async function POST(req: Request): Promise<Response> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY) return reject(413, "PAYLOAD_TOO_LARGE", "Pipeline event exceeds 500 KB.");
  let body: string;
  try {
    body = await req.text();
  } catch {
    return reject(400, "BAD_REQUEST", "Pipeline event must be a JSON object.");
  }
  const decision = acceptPipelineEvent(body, req.headers.get(PIPELINE_WEBHOOK_HEADER), pipelineWebhookSecret());
  if (!decision.ok) return reject(decision.status, decision.code, decision.message);
  let receivedAt = new Date().toISOString();
  try {
    receivedAt = (await writeSelectedRelease({ receivedAt, evidence: decision.evidence })).receivedAt;
  } catch {
    return reject(500, "STORE_FAILED", "Could not store the pipeline event.");
  }
  return Response.json(
    { ok: true, pipelineId: decision.evidence.pipelineId, commitSha: decision.evidence.commitSha, receivedAt },
    { headers: { "cache-control": "private, no-store" } },
  );
}

export async function GET(): Promise<Response> {
  let selected: Awaited<ReturnType<typeof readSelectedRelease>> = null;
  let releases: Awaited<ReturnType<typeof readReleaseHistory>> = [];
  let storage: "durable" | "local" | "unconfigured" = "unconfigured";
  try {
    releases = await readReleaseHistory(); selected = releases[0] ?? null;
    storage = persistenceMode() === "blob" ? "durable" : "local";
  } catch (error) {
    // An unconfigured preview has no received history. The shipped Podinfo receipts still merge on the client.
    if (!storageUnconfigured(error)) return reject(503, "STORE_UNAVAILABLE", "Release history is temporarily unavailable.");
  }
  return Response.json(
    {
      ok: true,
      configured: pipelineWebhookSecret() !== null,
      webhookPath: PIPELINE_WEBHOOK_PATH,
      receivedAt: selected?.receivedAt ?? null,
      evidence: selected?.evidence ?? null,
      releases,
      storage,
    },
    { headers: { "cache-control": "private, no-store" } },
  );
}
