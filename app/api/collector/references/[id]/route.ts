import podinfo from "../../../../../lib/reference/podinfo-source.json" with {type:"json"};
import boutique from "../../../../../lib/reference/online-boutique-source.json" with {type:"json"};
import {readCollectedArtifact} from "../../../../../lib/collector/read";

// Public, safe derived captures. Raw source trees and scan outputs are never served.
const captures=[podinfo,boutique];
export async function GET(_request:Request,{params}:{params:Promise<{id:string}>}) {
 const {id}=await params,capture=captures.find(c=>c.source.commit===id);
 if(!capture) return Response.json({error:"Source capture not found."},{status:404});
 const artifacts=capture.artifacts.map(readCollectedArtifact);
 if(artifacts.some(a=>!a)) return Response.json({error:"Invalid source capture."},{status:500});
 return Response.json({source:capture.source,artifacts});
}
