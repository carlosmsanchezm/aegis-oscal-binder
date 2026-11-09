import { withSession } from "@/lib/server/http";
import { fetchGithubCapture, githubErrorResponse } from "@/lib/github/connect";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(req: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  return withSession(req, async () => {
    try { return await fetchGithubCapture(req, (await context.params).id); }
    catch (error) { return githubErrorResponse(error); }
  });
}
