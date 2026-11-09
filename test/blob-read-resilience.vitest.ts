import {beforeEach,afterEach,it,expect,vi} from "vitest";
const io=vi.hoisted(()=>({get:vi.fn(),head:vi.fn(),put:vi.fn()}));
vi.mock("@vercel/blob",async original=>({...await original<typeof import("@vercel/blob")>(),get:(...args:any[])=>io.get(...args),head:(...args:any[])=>io.head(...args),put:(...args:any[])=>io.put(...args)}));
import {blobGetText,blobGetBytes,blobGetVersionedText,blobPutText,DurableConflictError} from "../lib/durable";
import {builderHandler} from "../lib/server/builder-http";
const response=()=>({statusCode:200,blob:{etag:'"one"'},stream:new Response("verified bytes").body});
beforeEach(()=>{
 vi.stubEnv("VERCEL_ENV","production");vi.stubEnv("BLOB_READ_WRITE_TOKEN","synthetic-test-token");
 io.get.mockReset().mockImplementation(async()=>response());io.head.mockReset().mockResolvedValue({etag:"one"});io.put.mockReset();
 vi.spyOn(console,"warn").mockImplementation(()=>{});vi.spyOn(console,"error").mockImplementation(()=>{});
});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();});
it("recovers a transient private download 500 without surfacing a successful empty view",async()=>{
 io.get.mockRejectedValueOnce(new Error("Vercel Blob: Failed to fetch blob: 500 private-marker"));
 const result=await builderHandler(async()=>Response.json({bytes:await blobGetText("private-marker")}));
 expect(result.status).toBe(200);expect(await result.json()).toEqual({bytes:"verified bytes"});expect(io.get).toHaveBeenCalledTimes(2);
 expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain("private-marker");
});
it("retries body-stream network failures with a fresh complete download",async()=>{
 io.get.mockResolvedValueOnce({statusCode:200,blob:{etag:'"one"'},stream:new ReadableStream({start(c){c.error(new TypeError("fetch failed",{cause:{code:"ECONNRESET"}}));}})});
 expect(await blobGetBytes("private-marker")).toEqual(Buffer.from("verified bytes"));expect(io.get).toHaveBeenCalledTimes(2);
});
it("bounds retries and still refuses persistent failure, denied reads, and version conflicts",async()=>{
 io.get.mockRejectedValue(new Error("Vercel Blob: Failed to fetch blob: 500 private-marker"));
 await expect(blobGetText("private-marker")).rejects.toThrow("Durable read failed");expect(io.get).toHaveBeenCalledTimes(3);
 io.get.mockClear().mockRejectedValue(new Error("Vercel Blob: Failed to fetch blob: 403 private-marker"));
 await expect(blobGetText("private-marker")).rejects.toThrow("Durable read failed");expect(io.get).toHaveBeenCalledTimes(1);
 io.get.mockClear().mockImplementation(async()=>response());io.head.mockResolvedValue({etag:"two"});
 await expect(blobGetVersionedText("private-marker")).rejects.toBeInstanceOf(DurableConflictError);expect(io.get).toHaveBeenCalledTimes(1);
 io.put.mockRejectedValue(new Error("Vercel Blob: Failed to fetch blob: 500 private-marker"));
 await expect(blobPutText("private-marker","bytes",false)).rejects.toThrow("Durable write failed");expect(io.put).toHaveBeenCalledTimes(1);
});
it("bounds download fan-out across callers and releases permits after a failed read",async()=>{
 let active=0,peak=0;
 io.get.mockImplementation(async(path:string)=>{
  active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,5));active--;
  if(path==="denied")throw new Error("Vercel Blob: Failed to fetch blob: 403 forbidden");return response();
 });
 const results=await Promise.allSettled(Array.from({length:40},(_,i)=>blobGetText(i===0?"denied":"object"+i)));
 expect(peak).toBeLessThanOrEqual(16);expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(39);expect(active).toBe(0);
 expect(await blobGetText("later")).toBe("verified bytes");
});
