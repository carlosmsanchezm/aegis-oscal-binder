import {connectionRoute,apiJson,agentHttpError} from "@/lib/agent/http";
import {boundedBody} from "@/lib/server/builder-http";
import {breakGlass} from "@/lib/github/poam-gate";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export async function POST(req:Request){
  try {
    const input=JSON.parse(await boundedBody(req));
    return connectionRoute(req,async a=>apiJson(await breakGlass(req,a.sessionId,a.connectionId,a.owner!,input)),{connectionId:input.connectionId,human:true,write:true});
  }catch(e){return agentHttpError(e);}
}
