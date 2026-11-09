import { withSession } from "@/lib/server/http";
import { githubErrorResponse, listGithubRepos } from "@/lib/github/connect";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(req: Request): Promise<Response> {
  return withSession(req, async () => {
    try { return await listGithubRepos(req); }
    catch (error) { return githubErrorResponse(error); }
  });
}
