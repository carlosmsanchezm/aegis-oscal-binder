import {collectAndRetainRelease} from "@/lib/collector/trusted-release";
import {getSession} from "@/lib/aegis";
import {builderMutationDenial} from "@/lib/account/access";
import {withSession,jsonOk,jsonError} from "@/lib/server/http";
import {boundedBody,checkBrowserMutation} from "@/lib/server/builder-http";
import {githubOwner,githubErrorResponse} from "@/lib/github/connect";
import {findConnectedRepo,saveCapture} from "@/lib/github/store";
import {scanPinnedRepository} from "@/lib/github/client";
import {builderOwner,createPullConnection,bindGithubConnection,listConnections} from "@/lib/server/builder-store";
import {ReleaseReadError} from "@/lib/collector/github-release";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export const maxDuration=300;
export function POST(req:Request){return withSession(req,async()=>{
 const started=Date.now(),diagnostic=(stage:string)=>{if(process.env.AEGIS_COLLECTION_DIAGNOSTICS==="true")console.info("GitHub collection route",{stage,elapsedMs:Date.now()-started});};
 try{
  checkBrowserMutation(req);const denied=await builderMutationDenial(req);if(denied)return jsonOk({error:denied.message},denied.status);const body=JSON.parse(await boundedBody(req)) as Record<string,unknown>;
  if(typeof body.owner!=="string"||typeof body.repo!=="string"||!/^[-A-Za-z0-9_.]{1,100}$/.test(body.owner)||!/^[-A-Za-z0-9_.]{1,100}$/.test(body.repo))return jsonOk({error:"Select a connected repository."},400);
  const principal=await githubOwner(req),connected=await findConnectedRepo(principal,body.owner,body.repo),owner=builderOwner(req.headers.get("cookie"));
  if(!connected||connected.installation.suspended||!owner)return jsonOk({error:"Connect this repository and browser workspace before collecting."},403);
  const runId=body.runId==null?undefined:Number(body.runId);if(runId!==undefined&&(!Number.isSafeInteger(runId)||runId<=0))return jsonOk({error:"Invalid workflow run."},400);
  const name=body.owner==="carlosmsanchezm"&&body.repo==="microservices-demo"?"Online Boutique":`${connected.repo.owner}/${connected.repo.name}`.slice(0,100),connections=await listConnections(owner);
  const github={installationId:connected.installation.installationId,owner:connected.repo.owner,repo:connected.repo.name};
  const connection=connections.find(c=>!c.revokedAt&&c.github?.installationId===github.installationId&&c.github.owner.toLowerCase()===github.owner.toLowerCase()&&c.github.repo.toLowerCase()===github.repo.toLowerCase())??connections.find(c=>!c.revokedAt&&!c.github&&c.name===name)??await createPullConnection(name,owner,undefined,github);
  if(!connection.github)await bindGithubConnection(connection.id,owner,github);
  diagnostic("native-collection-started");
  const bundle=await collectAndRetainRelease(connection.id,getSession().id,{installationId:connected.installation.installationId,owner:body.owner,repo:body.repo,runId});
  diagnostic("native-collection-complete");
  const result={event:bundle.event,commit:bundle.event.subject.revision,runId:bundle.event.run.id};
  const capturedAt=result.event.run.observedAt;
  diagnostic("source-inventory-started");
  const capture=await scanPinnedRepository({installationId:connected.installation.installationId,owner:body.owner,repo:body.repo,ref:result.commit,capturedAt});
  await saveCapture(principal,capture,connected.installation.installationId);
  diagnostic("source-inventory-retained");
  return jsonOk({connectionId:connection.id,receipt:bundle.id,runId:result.runId,commit:result.commit});
 }catch(error){if(error instanceof ReleaseReadError)return jsonOk({error:error.message},422);if(error instanceof SyntaxError)return jsonOk({error:"Invalid collection request."},400);return githubErrorResponse(error);}
});}
