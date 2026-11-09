import { withSession } from "@/lib/server/http";
import { githubErrorResponse, startGithubInstall } from "@/lib/github/connect";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(req: Request): Promise<Response> {
  return withSession(req, async () => {
    try { return await startGithubInstall(req); }
    catch (error) { return githubErrorResponse(error); }
  });
}
