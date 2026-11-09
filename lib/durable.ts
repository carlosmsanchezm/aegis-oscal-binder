import { get, head, list, put, BlobPreconditionFailedError } from "@vercel/blob";
import { createHash } from "node:crypto";
import { storageKey } from "./storage-key";

/**
 * Shared store for inbound pipeline releases, loaded session packages,
 * saved remediation drafts, uploaded evidence bytes, and exported files.
 *
 * `AEGIS_DATA_DIR` selects a directory (a container volume or a test directory).
 * When it is unset, `BLOB_READ_WRITE_TOKEN` selects the private Vercel Blob
 * store connected to this deployment. Preview and production use different
 * tokens. Preview also refuses the production store id below. On Vercel, with
 * neither configured, reads and writes fail instead of using the instance
 * temp directory.
 *
 * Object keys are built only by `storageKey`.
 */
export const PIPELINE_RELEASE_PREFIX = `${storageKey(["pipeline-releases"])}/`;

export function builderStoragePrefix(): string {
  return `${storageKey(["builder"])}/`;
}

export function sessionBlobPath(id: string): string {
  return storageKey(["sessions", id, "state.json"]);
}

export type PersistenceMode = "blob" | "directory";

export type BlobIo = {
  getVersioned?(pathname: string): Promise<{text:string;etag:string}|null>;
  putIfVersion?(pathname:string,body:string,etag:string|null):Promise<void>;
  put(pathname: string, body: string, allowOverwrite: boolean): Promise<void>;
  get(pathname: string): Promise<string | null>;
  list(prefix: string): Promise<string[]>;
  putBytes?(pathname: string, body: Uint8Array, allowOverwrite: boolean): Promise<void>;
  getBytes?(pathname: string): Promise<Uint8Array | null>;
};

let blobIoOverride: BlobIo | null = null;

export class DurableConflictError extends Error {}
export class DurableStorageError extends Error {
  readonly name="DurableStorageError";
  constructor(public operation:string,public category:"http"|"network"|"backend",public upstreamStatus?:number){super(`Durable ${operation} failed.`);}
}
// Flow control only: no credentials, bytes or session data are shared here.
const reads=(()=>{
  const runtime=globalThis as unknown as {__aegisBlobReads?:{active:number;waiting:(()=>void)[]}};
  return runtime.__aegisBlobReads??= {active:0,waiting:[]};
})();
async function readSlot<T>(read:()=>Promise<T>):Promise<T>{
  if(reads.active>=16)await new Promise<void>(resolve=>reads.waiting.push(resolve));else reads.active++;
  try{return await read();}finally{const next=reads.waiting.shift();if(next)next();else reads.active--;}
}
/** Retry complete downloads only, never writes, denied access or invalid proof. */
async function resilientRead<T>(read:()=>Promise<T>):Promise<T>{
  for(let attempt=1;;attempt++){
    try{return await readSlot(read);}
    catch(error){
      if(error instanceof DurableConflictError)throw error;
      const failure=cleanFailure("read",error);
      if(attempt>=3||!(failure.category==="network"||[408,429,500,502,503,504].includes(failure.upstreamStatus??0)))throw failure;
      console.warn("Transient Blob read retry",{operation:"read",category:failure.category,...(failure.upstreamStatus?{upstreamStatus:failure.upstreamStatus}:{}),attempt});
      await new Promise(resolve=>setTimeout(resolve,attempt*250));
    }
  }
}
/** Read bytes and their version together; never combine an old body with a new ETag. */
export async function blobGetVersionedText(pathname:string):Promise<{text:string;etag:string}|null> {
  assertPreviewBlobStore();
  if(blobIoOverride?.getVersioned)return blobIoOverride.getVersioned(pathname);
  if(blobIoOverride){const text=await blobIoOverride.get(pathname);return text===null?null:{text,etag:createHash("sha256").update(text).digest("hex")};}
  return resilientRead(async()=>{try {
    const response=await get(pathname,{access:"private",token:blobToken(),useCache:false,headers:{"Accept-Encoding":"identity"}});
    if(!response||response.statusCode!==200)return null;
    const text=await new Response(response.stream).text();
    const metadata=await head(pathname,{token:blobToken()});
    // Delivery headers can quote the opaque version differently from the write API.
    // Bind the downloaded body to the current control-plane version, never a newer one.
    const opaque=(value:string)=>value.startsWith('"')&&value.endsWith('"')?value.slice(1,-1):value;
    if(!response.blob.etag||response.blob.etag.startsWith("W/")||!metadata.etag)throw cleanFailure("read");
    if(opaque(response.blob.etag)!==opaque(metadata.etag))throw new DurableConflictError();
    return {text,etag:metadata.etag};
  }catch(error){if(error instanceof DurableConflictError)throw error;throw cleanFailure("read",error);}});
}
/** Conditional replacement of the same object. A conflict never falls back to overwrite. */
export async function blobPutTextIfVersion(pathname:string,body:string,etag:string|null):Promise<void> {
  assertPreviewBlobStore();
  if(blobIoOverride?.putIfVersion)return blobIoOverride.putIfVersion(pathname,body,etag);
  if(blobIoOverride){
    // Legacy in-memory test adapters only. Cross-process tests supply atomic version methods.
    if((await blobGetVersionedText(pathname))?.etag!== (etag??undefined))throw new DurableConflictError();
    return blobIoOverride.put(pathname,body,etag!==null);
  }
  try {
    await put(pathname,body,{access:"private",token:blobToken(),contentType:"application/json",addRandomSuffix:false,cacheControlMaxAge:60,allowOverwrite:etag!==null,...(etag!==null?{ifMatch:etag}:{})});
  }catch(error){
    if(error instanceof BlobPreconditionFailedError)throw new DurableConflictError();
    if(etag===null&&await blobGetVersionedText(pathname))throw new DurableConflictError();
    throw cleanFailure("write",error);
  }
}

/** Test double for the Blob client. Production leaves this unset. */
export function setBlobIoForTests(io: BlobIo | null): void {
  blobIoOverride = io;
}

export function blobToken(): string | undefined {
  const value = process.env.BLOB_READ_WRITE_TOKEN?.trim() ?? "";
  return value ? value : undefined;
}

/** Production private Blob store. Preview must not use this store. */
export const PRODUCTION_BLOB_STORE_ID = "Fxqd0vquINMYjsKb";

export const PREVIEW_STORE_REFUSED = "Preview cannot use the production Blob store.";

export function blobStoreIdFromToken(token: string | undefined): string {
  if (!token) return "";
  return token.split("_")[3] ?? "";
}

function normalizedStoreId(value: string | undefined): string {
  const trimmed = value?.trim() ?? "";
  return trimmed.startsWith("store_") ? trimmed.slice("store_".length) : trimmed;
}

/** Preview deployments refuse the production store even when a token is present. */
export function assertPreviewBlobStore(): void {
  if (process.env.VERCEL_ENV !== "preview") return;
  const ids = [
    normalizedStoreId(process.env.BLOB_STORE_ID),
    blobStoreIdFromToken(blobToken()),
  ].filter(Boolean);
  if (ids.includes(PRODUCTION_BLOB_STORE_ID)) throw new Error(PREVIEW_STORE_REFUSED);
}

/** Development's local directory is configured implicitly; Vercel requires an explicit backend. */
export function durableStorageConfigured(): boolean {
  return !process.env.VERCEL || Boolean(process.env.AEGIS_DATA_DIR?.trim() || blobToken() || blobIoOverride);
}

export function persistenceMode(): PersistenceMode {
  if (process.env.AEGIS_DATA_DIR?.trim()) return "directory";
  assertPreviewBlobStore();
  if (blobToken() || blobIoOverride) return "blob";
  if (process.env.VERCEL) throw new Error("Durable storage is not configured.");
  return "directory";
}

export function storageUnconfigured(error: unknown): boolean {
  return error instanceof Error && error.message === "Durable storage is not configured.";
}

function cleanFailure(action: string,error?:unknown): DurableStorageError {
  if(error instanceof DurableStorageError)return error;
  const e=error as {message?:string;status?:number;cause?:{code?:string}};
  const fromMessage=/^Vercel Blob: Failed to fetch blob: ([45][0-9]{2})(?: |$)/.exec(e?.message??"");
  const status=fromMessage?Number(fromMessage[1]):Number.isInteger(e?.status)&&e.status!>=400&&e.status!<=599?e.status:undefined;
  const network=e?.message==="fetch failed"||["ECONNRESET","ETIMEDOUT","UND_ERR_SOCKET","UND_ERR_CONNECT_TIMEOUT"].includes(e?.cause?.code??"");
  return new DurableStorageError(action,status?"http":network?"network":"backend",status);
}

export async function blobGetText(pathname: string): Promise<string | null> {
  assertPreviewBlobStore();
  if (blobIoOverride) return blobIoOverride.get(pathname);
  return resilientRead(async()=>{try {
    const response = await get(pathname, { access: "private", token: blobToken(), useCache: false });
    if (!response || response.statusCode !== 200) return null;
    return await new Response(response.stream).text();
  } catch (error) {
    if (error instanceof Error && error.message === "Durable read failed.") throw error;
    throw cleanFailure("read",error);
  }});
}

export async function blobPutText(pathname: string, body: string, allowOverwrite: boolean, cacheControlMaxAge?: number): Promise<void> {
  assertPreviewBlobStore();
  if (blobIoOverride) {
    await blobIoOverride.put(pathname, body, allowOverwrite);
    return;
  }
  try {
    await put(pathname, body, {
      access: "private",
      token: blobToken(),
      contentType: "application/json",
      addRandomSuffix: false,
      allowOverwrite,
      ...(cacheControlMaxAge ? { cacheControlMaxAge } : {}),
    });
  } catch (error) {
    if (error instanceof Error && error.message === "Durable write failed.") throw error;
    throw cleanFailure("write",error);
  }
}

export async function blobPutBytes(pathname: string, body: Buffer, allowOverwrite: boolean, contentType: string): Promise<void> {
  assertPreviewBlobStore();
  if (blobIoOverride?.putBytes) {
    await blobIoOverride.putBytes(pathname, body, allowOverwrite);
    return;
  }
  if (blobIoOverride) {
    await blobIoOverride.put(pathname, body.toString("base64"), allowOverwrite);
    return;
  }
  try {
    await put(pathname, body, {
      access: "private",
      token: blobToken(),
      contentType,
      addRandomSuffix: false,
      allowOverwrite,
    });
  } catch (error) {
    if (error instanceof Error && error.message === "Durable write failed.") throw error;
    throw cleanFailure("write",error);
  }
}

export async function blobGetBytes(pathname: string): Promise<Buffer | null> {
  assertPreviewBlobStore();
  if (blobIoOverride?.getBytes) {
    const body = await blobIoOverride.getBytes(pathname);
    return body ? Buffer.from(body) : null;
  }
  if (blobIoOverride) {
    const encoded = await blobIoOverride.get(pathname);
    if (encoded == null) return null;
    return Buffer.from(encoded, "base64");
  }
  return resilientRead(async()=>{try {
    const response = await get(pathname, { access: "private", token: blobToken(), useCache: false });
    if (!response || response.statusCode !== 200) return null;
    return Buffer.from(await new Response(response.stream).arrayBuffer());
  } catch (error) {
    if (error instanceof Error && error.message === "Durable read failed.") throw error;
    throw cleanFailure("read",error);
  }});
}

export async function listBlobPathnames(prefix: string): Promise<{ pathname: string; uploadedAt: number }[]> {
  assertPreviewBlobStore();
  if (blobIoOverride) {
    const names = await blobIoOverride.list(prefix);
    return names.filter((name) => name.startsWith(prefix)).map((pathname) => ({ pathname, uploadedAt: 0 }));
  }
  try {
    const blobs: { pathname: string; uploadedAt: number }[] = [];
    let cursor: string | undefined;
    do {
      const page = await list({ prefix, limit: 1000, token: blobToken(), cursor });
      for (const blob of page.blobs) blobs.push({ pathname: blob.pathname, uploadedAt: blob.uploadedAt.valueOf() });
      if (blobs.length > 10000) throw new Error("Release history needs indexed storage at this scale.");
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
    return blobs;
  } catch (error) {
    if (error instanceof Error && error.message === "Release history needs indexed storage at this scale.") throw error;
    throw cleanFailure("list",error);
  }
}
