import type {PipelineEvidence} from "../aegis/pipeline-evidence";
import {readCollectedArtifact} from "./read";

/** Public captured inventory is fetched only for an explicit load request. */
export async function loadSourceInventory(record:PipelineEvidence, request:typeof fetch=fetch):Promise<PipelineEvidence> {
 if(!record.sourceInventoryHref) return record;
 if(!/^\/api\/collector\/references\/[a-f0-9]{40}$/.test(record.sourceInventoryHref)) throw new Error("Invalid source inventory reference.");
 const response=await request(record.sourceInventoryHref,{cache:"no-store"});
 if(!response.ok) throw new Error("Captured source inventory is unavailable.");
 const capture=await response.json() as {source?:{commit?:unknown};artifacts?:unknown};
 const value=capture?.artifacts;
 if(capture?.source?.commit !== record.sourceInventoryHref.split("/").at(-1) || !Array.isArray(value) || value.length>1000) throw new Error("Invalid source inventory.");
 const artifacts=value.map(readCollectedArtifact);
 if(artifacts.some(a=>!a) || new Set(artifacts.map(a=>a!.name)).size!==artifacts.length) throw new Error("Invalid source inventory.");
 return {...record,collectedArtifacts:artifacts.filter(a=>a!==null)};
}

/** Source captures remain separate from the selected receipt's sealed measurements. */
export function withSourceInventories(record:PipelineEvidence, inventories:PipelineEvidence[]):PipelineEvidence {
 const artifacts=[...new Map([...inventories.flatMap(item=>item.collectedArtifacts ?? []), ...(record.collectedArtifacts ?? [])].map(artifact=>[artifact.name,artifact])).values()];
 return artifacts.length ? {...record,collectedArtifacts:artifacts} : record;
}
