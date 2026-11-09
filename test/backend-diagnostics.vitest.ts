import {afterEach,it,expect,vi} from "vitest";
const io=vi.hoisted(()=>({error:null as unknown}));
vi.mock("@vercel/blob",async original=>({...await original<typeof import("@vercel/blob")>(),get:async()=>{throw io.error;}}));
import {blobGetText,blobGetBytes,blobGetVersionedText} from "../lib/durable";
import {backendFailureDiagnostic} from "../lib/server/backend-diagnostics";
import {builderHandler} from "../lib/server/builder-http";
import {agentHttpError} from "../lib/agent/http";
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();});
it("retains only fixed upstream status diagnostics, never storage URLs, bodies or credentials",async()=>{
  vi.stubEnv("VERCEL_ENV","production");vi.stubEnv("BLOB_READ_WRITE_TOKEN","synthetic-token");
  io.error=new Error("Vercel Blob: Failed to fetch blob: 503 private-marker https://private.invalid/?token=private-marker");
  for(const read of [blobGetText,blobGetBytes,blobGetVersionedText]){
    const error=await read("private-marker").catch(e=>e);
    expect(error.message).toBe("Durable read failed.");
    expect(backendFailureDiagnostic(error)).toEqual({category:"http",operation:"read",upstreamStatus:503});
    expect(JSON.stringify(error)).not.toContain("private-marker");
  }
});
it("classifies network failures without retaining their sensitive cause",async()=>{
  vi.stubEnv("VERCEL_ENV","production");
  io.error=new TypeError("fetch failed",{cause:{code:"ECONNRESET",authorization:"private-marker"}});
  const error=await blobGetText("private-marker").catch(e=>e);
  expect(backendFailureDiagnostic(error)).toEqual({category:"network",operation:"read"});
  expect(error.cause).toBeUndefined();expect(JSON.stringify(error)).not.toContain("private-marker");
});
it("keeps unavailable data fail-closed while logging safe backend and chain categories",async()=>{
  const log=vi.spyOn(console,"error").mockImplementation(()=>{});
  io.error=new Error("Vercel Blob: Failed to fetch blob: 500 private-marker");
  const response=await builderHandler(async()=>{await blobGetText("private-marker");return Response.json({ok:true});});
  expect(response.status).toBe(503);expect(JSON.stringify(await response.json())).not.toContain("private-marker");
  expect(log).toHaveBeenCalledWith("Backend unavailable",{category:"http",operation:"read",upstreamStatus:500});
  expect(agentHttpError(new Error("Append-only chain verification failed.")).status).toBe(503);
  expect(log).toHaveBeenLastCalledWith("Backend unavailable",{category:"retained-chain-invalid"});
  expect(backendFailureDiagnostic(new Error("private-marker"))).toEqual({category:"backend-unclassified"});
});
