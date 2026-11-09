import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

/** Hosted tools already have a 300-second function limit. The SDK's 60-second
 * default can interrupt a valid provider operation after creation but before its
 * durable projection completes. Keep a finite matching deadline; never retry a
 * mutating tool here, since interrupted PR creation must reconcile its identity. */
export function proxyToolCall(client:Client,input:Parameters<Client["callTool"]>[0]) {
  return client.callTool(input,undefined,{timeout:300_000,maxTotalTimeout:300_000});
}
