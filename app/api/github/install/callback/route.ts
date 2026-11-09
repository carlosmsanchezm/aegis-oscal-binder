import { withSession } from "@/lib/server/http";
import { finishGithubInstall, githubErrorResponse } from "@/lib/github/connect";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(req: Request): Promise<Response> {
  return withSession(req, async () => {
    try { return await finishGithubInstall(req); }
    catch (error) { return githubErrorResponse(error); }
  });
}
