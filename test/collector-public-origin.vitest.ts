import {it,expect,vi} from "vitest";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {createConnection} from "../lib/server/builder-store";
import {parseEvidenceEvent} from "../lib/builder/evidence";
import {retainInternalCollectorEvent,trustedReleases} from "../lib/collector/trusted-release";
import event from "../fixtures/boutique-live/40446239616/event.json";

it("resolves retained proof links against the configured public host while preserving an explicit caller origin",async()=>{
 const folder=mkdtempSync(path.join(tmpdir(),"collector-public-origin-"));
 vi.stubEnv("AEGIS_DATA_DIR",folder);vi.stubEnv("AEGIS_PUBLIC_ORIGIN","https://dedicated-demo.example");
 try{
  const c=await createConnection("Public-origin unit test"),sid="f".repeat(32);
  const retained=await retainInternalCollectorEvent(c.connection.id,sid,parseEvidenceEvent(event));
  const [publicProof]=await trustedReleases(sid,c.connection.id);
  expect(publicProof.pipelineUrl).toBe(`https://dedicated-demo.example/api/builder/evidence/${retained.id}?connection=${c.connection.id}`);
  const [explicit]=await trustedReleases(sid,c.connection.id,"https://explicit-owner.example");
  expect(new URL(explicit.pipelineUrl).origin).toBe("https://explicit-owner.example");
 }finally{vi.unstubAllEnvs();rmSync(folder,{recursive:true,force:true});}
});
