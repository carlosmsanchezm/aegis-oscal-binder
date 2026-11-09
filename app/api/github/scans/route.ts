import { withSession } from "@/lib/server/http";
import { githubErrorResponse, scanGithubRepo } from "@/lib/github/connect";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(req: Request): Promise<Response> {
  return withSession(req, async () => {
    try { return await scanGithubRepo(req); }
    catch (error) { return githubErrorResponse(error); }
  });
}
