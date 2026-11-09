import {it,expect} from "vitest";
import {zipSync,strToU8} from "fflate";
import {createHash} from "node:crypto";
import {verifyReleaseArchive,releaseEventFromArchive} from "../lib/collector/github-release";
import {RELEASE_PERMISSIONS} from "../lib/github/permissions";
export function archive(patch:Record<string,unknown>={}){const data:Record<string,unknown>={"summary.json":{repository:"owner/repo",runId:123,commit:"a".repeat(40),observedAt:"2026-10-26T12:00:00Z"},"sast.json":{runs:[]},"dependencies.json":{Results:[]},"image.json":{Results:[]},"configuration.json":{Results:[]},"secrets.json":[],"sbom.cdx.json":{bomFormat:"CycloneDX",components:[]},"publisher-signature.json":{unavailable:true},"built-image-signature.json":{unavailable:true},"runtime.json":{healthy:true,podCount:12,readyCount:12},...patch};const files=Object.fromEntries(Object.entries(data).map(([k,v])=>[k,strToU8(JSON.stringify(v))]));const manifest=Object.fromEntries(Object.entries(files).map(([k,v])=>[k,createHash("sha256").update(v).digest("hex")]));return zipSync({...files,"manifest.json":strToU8(JSON.stringify(manifest))});}
it("verifies checksums and binds the evidence to the exact API run",()=>{const bytes=archive();expect(Object.keys(verifyReleaseArchive(bytes).files)).toHaveLength(11);expect(releaseEventFromArchive(bytes,{repository:"owner/repo",runId:123,commit:"a".repeat(40),observedAt:"2026-10-26T12:00:00Z"}).checks).toHaveLength(9);expect(()=>releaseEventFromArchive(bytes,{repository:"owner/repo",runId:124,commit:"a".repeat(40),observedAt:"2026-10-26T12:00:00Z"})).toThrow(/identity/);});
it("rejects missing manifests and checksum mismatches",()=>{expect(()=>verifyReleaseArchive(zipSync({"summary.json":strToU8("{}")}))).toThrow(/manifest/);expect(()=>verifyReleaseArchive(zipSync({"manifest.json":strToU8('{"summary.json":"'+"0".repeat(64)+'"}'),"summary.json":strToU8("{}")}))).toThrow(/mismatch/);});
it("requests read scopes only",()=>expect(Object.values(RELEASE_PERMISSIONS).every(v=>v==="read")).toBe(true));

it("emits canonical metadata and fact digests accepted by the existing retained observation store",async()=>{
 const {verifyBundle}=await import("../lib/server/builder-store");
 const event=releaseEventFromArchive(archive(),{repository:"owner/repo",runId:123,commit:"a".repeat(40),observedAt:"2026-10-26T12:00:00Z"}),rawEvent=JSON.stringify(event),id=createHash("sha256").update(rawEvent).digest("hex");
 expect(verifyBundle({schema:"aegis.evidence-bundle.v1",connectionId:"00000000-0000-0000-0000-000000000000",rawEvent,event,id,receivedAt:event.run.observedAt,integrity:"verified",authentication:"browser-owner"}).id).toBe(id);
});
