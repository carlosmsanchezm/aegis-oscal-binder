import source from "@/lib/reference/online-boutique-source.json";
import {readCollectedArtifact} from "@/lib/collector/read";
import {collectorEvents} from "@/lib/collector/events";
import before from "@/lib/reference/online-boutique-before.json";
import after from "@/lib/reference/online-boutique-after.json";
import { builderHandler, builderJson, BuilderRequestError } from "@/lib/server/builder-http";
import { verifyBundle } from "@/lib/server/builder-store";
import { parseEvidenceEvent } from "@/lib/builder/evidence";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Safe immutable public capture only; no owner/session state is cached.
let retainedCaptures: {id:string;rawEvent:string}[] | undefined;
function referenceCaptures(){
 if(retainedCaptures)return retainedCaptures;
 const captures=[before,after,...collectorEvents(source.artifacts.map(a=>readCollectedArtifact(a)!))];
    for (const capture of captures) {
      const event = parseEvidenceEvent(JSON.parse(capture.rawEvent));
      verifyBundle({ schema: "aegis.evidence-bundle.v1", ...capture,
        connectionId: "00000000-0000-4000-8000-000000000000", receivedAt: event.run.observedAt,
        event, integrity: "verified", authentication: "browser-owner" }, capture.id);
    }
 retainedCaptures=captures;
 return captures;
}

/** Approved, non-secret captured test data. Never refreshed or silently injected into a workspace. */
export async function GET(req: Request) {
  return builderHandler(async () => {
    const captures = referenceCaptures();
    const stage = new URL(req.url).searchParams.get("stage");
    if (stage !== null) {
      if (stage !== "before" && stage !== "after") throw new BuilderRequestError("Capture not found.", 404);
      return new Response((stage === "before" ? before : after).rawEvent, { headers: {
        "content-type": "application/json", "content-disposition": `attachment; filename="online-boutique-${stage}.json"`,
        "cache-control": "no-store", "x-content-type-options": "nosniff",
      } });
    }
    return builderJson({ ok: true, name: "Online Boutique · captured reference",
      source: `${source.source.repo}/tree/${source.source.commit}`,
      capturedAt: "2026-10-06T02:54:20.862Z", events: captures,
      limitations: "Actual local reference measurements with an operator-performed correction. Historical capture; no fresh scan or AI repair is asserted." });
  });
}
