import { githubErrorResponse, receiveGithubWebhook } from "@/lib/github/connect";
import {after} from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: Request): Promise<Response> {
  try { return await receiveGithubWebhook(req,after); }
  catch (error) { return githubErrorResponse(error); }
}
