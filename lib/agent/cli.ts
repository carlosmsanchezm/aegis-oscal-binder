import { writeFileSync } from "node:fs";
import {
  createAgentToken,
  listAgentTokens,
  serializeAgentToken,
  revokeAgentToken,
  AGENT_SCOPES,
  type AgentScope,
} from "./agent-token";
export async function agentTokenCli(args: string[]) {
  const action = args[0];
  const option = (n: string) => {
    const i = args.indexOf(n);
    return i < 0 ? undefined : args[i + 1];
  };
  const connection = option("--connection"),
    owner = process.env.AEGIS_OWNER_SECRET;
  if (!connection || !owner)
    throw new Error("Set AEGIS_OWNER_SECRET and pass --connection.");
  if (action === "list") {
    const records = await listAgentTokens(connection, owner);
    console.log(
      JSON.stringify(
        records.map((r) => serializeAgentToken(r)),
        null,
        2,
      ),
    );
    return;
  }
  if (action === "revoke") {
    await revokeAgentToken(connection, owner, option("--id") ?? "");
    console.log("Agent token revoked.");
    return;
  }
  if (action !== "create")
    throw new Error("Use agent-token create|list|revoke.");
  const out = option("--out"),
    sessionId = process.env.AEGIS_SESSION_ID;
  if (!out || !sessionId)
    throw new Error(
      "Set AEGIS_SESSION_ID and pass --out for one-time credential delivery.",
    );
  const scopes = (option("--scopes") ?? "read_findings").split(
    ",",
  ) as AgentScope[];
  if (scopes.some((s) => !AGENT_SCOPES.includes(s)))
    throw new Error("Invalid scopes.");
  const result = await createAgentToken(connection, owner, sessionId, scopes, {
    expires_at: option("--expires-at"),
  });
  writeFileSync(out, result.token + "\n", { flag: "wx", mode: 0o600 });
  console.log(
    "Agent credential written to the private output file. It will not be printed.",
  );
}
