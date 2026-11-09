import podinfo from "@/lib/reference/podinfo-source.json";
import boutique from "@/lib/reference/online-boutique-source.json";
/** Public, derived metadata only. Raw upstream and scanner bytes are not shipped. */
export async function GET(_req: Request, context: {params: Promise<{id:string}>}) {
  const {id} = await context.params;
  const artifact = [...podinfo.artifacts, ...boutique.artifacts].find(a=>a.sha256===id);
  if (!artifact || !/^[a-f0-9]{64}$/.test(id)) return new Response("Artifact not found",{status:404});
  return Response.json(artifact,{headers:{"cache-control":"public, max-age=31536000, immutable","x-content-type-options":"nosniff"}});
}
