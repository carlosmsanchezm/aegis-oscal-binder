import {readBundleZip} from "@/lib/manifest/bundle";
import {verifyManifest} from "@/lib/manifest/manifest";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export async function POST(req:Request){try{
 const reader=req.body?.getReader();if(!reader)throw new Error("Body required.");const chunks:Uint8Array[]=[];let size=0;
 while(true){const item=await reader.read();if(item.done)break;size+=item.value.length;if(size>30_000_000){await reader.cancel();return Response.json({status:"invalid",exitCode:1,errors:["Bundle too large."]},{status:413});}chunks.push(item.value);}
 const bundle=readBundleZip(Buffer.concat(chunks)),result=verifyManifest(bundle.manifest,bundle.files,req.headers.get("x-aegis-manifest-public-key")??undefined);
 return Response.json(result,{status:result.exitCode===1?422:200,headers:{"cache-control":"no-store"}});
 }catch{return Response.json({status:"invalid",exitCode:1,errors:["Malformed or unsafe bundle."]},{status:400});}}
