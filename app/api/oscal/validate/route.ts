import {validateSchema} from "@/lib/oscal/validate-schema";
import {boundedBody} from "@/lib/server/builder-http";
import { postValidate } from "@/lib/server/handlers";
import { readJson, withSession } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(req: Request) {
  return withSession(req, async () => {const body=JSON.parse(await boundedBody(req));if(body.document){const result=validateSchema(body.document);return Response.json(result,{status:result.valid?200:422});}return postValidate(body);});
}
