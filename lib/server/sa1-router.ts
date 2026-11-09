import { AegisError } from "@/lib/aegis";
import * as handlers from "./handlers";
import * as digest from "./digest-handlers";
import { readJson, withSession } from "./http";

/** Keep the ephemeral rehearsal session in one server function on hosts whose
 * individual route functions do not share a filesystem. Same domain handlers;
 * no alternate gate, serializer, validator, or production workspace state. */
export function sa1Request(req: Request, parts: string[]): Promise<Response> {
  const headers = new Headers(req.headers);
  headers.set("x-aegis-workspace", "sa1-demo");
  const scoped = new Request(req, { headers });
  return withSession(scoped, async () => {
    const action = parts.join("/");
    if (req.method === "GET") {
      switch (action) {
        case "digest/files": return digest.getStoredFiles();
        case "digest/verify": return digest.getDigestCheck();
        case "digest/refusals": return digest.getDigestRefusals();
        case "package": return handlers.getPackage();
        case "gate": return handlers.getGate();
        case "changes": return handlers.getChanges();
        case "catalogs": return handlers.getCatalogs();
        case "future": return handlers.getFuture();
        case "attempts": return handlers.getAttempts();
        case "pipeline/mappings": return handlers.getPipelineMappings(req);
        case "artifacts/oscal": return handlers.getOscalArtifact();
        case "artifacts/word": return handlers.getWordArtifact();
        case "artifacts/excel": return handlers.getExcelArtifact();
      }
    }
    if (req.method === "GET" && parts[0] === "digest" && parts[1] === "refusals" && parts.length === 3) return digest.getDigestRefusal(parts[2]);
    if (req.method === "GET" && parts[0] === "controls" && parts.length === 5 && parts[2] === "evidence" && parts[4] === "bytes") return digest.getEvidenceBytes(parts[1], parts[3]);
    if (req.method === "POST") {
      switch (action) {
        case "digest/verify": return digest.postDigestCheck(await readJson(scoped));
        case "digest/regenerate": return digest.postRegenerateExport(await readJson(scoped));
        case "catalogs/select": return handlers.postSelectCatalog(await readJson(scoped));
        case "oscal/ingest": return handlers.postOscalIngest(scoped);
        case "ingest/csv": return handlers.postCsvIngest(scoped);
        case "package/reset": return handlers.postResetPackage();
        case "workspace/reset": return handlers.postResetWorkspace();
        case "fixtures/load": return handlers.postLoad(await readJson(scoped));
        case "oscal/export": return handlers.postExport();
        case "oscal/validate": return handlers.postValidate(await readJson(scoped));
        case "render/word": return handlers.postRender("word");
        case "render/excel": return handlers.postRender("excel");
        case "baseline": return handlers.postBaseline();
        case "pipeline/mappings": return handlers.postPipelineMapping(await readJson(scoped), scoped);
      }
      if (parts[0] === "controls" && parts.length === 3 && parts[2] === "save") return handlers.postSave(parts[1], await readJson(scoped));
      if (parts[0] === "controls" && parts.length === 3 && parts[2] === "evidence") return handlers.postEvidence(parts[1], await readJson(scoped));
      if (parts[0] === "controls" && parts.length === 4 && parts[2] === "evidence" && parts[3] === "file") return handlers.postEvidenceFile(parts[1], scoped);
    }
    if (req.method === "PATCH" && parts[0] === "controls") {
      if (parts.length === 2) return handlers.patchControl(parts[1], await readJson(scoped));
      if (parts.length === 4 && parts[2] === "evidence") return handlers.patchEvidence(parts[1], parts[3], await readJson(scoped));
    }
    throw new AegisError("NOT_FOUND", "Unknown SA1 demo action.", 404);
  });
}
