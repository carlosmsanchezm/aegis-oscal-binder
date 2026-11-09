import {
  randomBytes,
  randomUUID,
  timingSafeEqual,
  createHash,
} from "node:crypto";
import { redactText } from "../aegis/gates/redact";
import { readActiveSession } from "../aegis/store";
import type { RefusalCode } from "./refusal";
import { storageKey } from "../storage-key";
import {
  appendLog,
  readLog,
  objectKeys,
  readObject,
  writeObjectOnce,
} from "../immutable-log";
import { readConnection, ownsConnection } from "../server/builder-store";
import {
  AGENT_SCOPES,
  hasAgentScope,
  workflowScope,
  type AgentScope,
} from "./scopes";
export {
  AGENT_SCOPES,
  hasAgentScope,
  workflowScope,
  type AgentScope,
} from "./scopes";
export const DEFAULT_AGENT_TOKEN_TTL_MS = 15 * 60 * 1000;
export const MAX_AGENT_TOKEN_TTL_MS = 2 * 60 * 60 * 1000;
export type AgentToken = {
  id: string;
  hash: string;
  connectionId: string;
  ownerHash: string;
  sessionId: string;
  scopes: AgentScope[];
  createdAt: string;
  expires_at?: string;
  revokedAt?: string;
};
export class AgentAccessError extends Error {
  constructor(
    message: string,
    readonly status = 401,
    readonly code: RefusalCode = "authentication",
    readonly auditIdentity?: { tokenId: string; connectionId: string },
  ) {
    super(message);
  }
}
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
function key(id: string) {
  if (!/^[a-f0-9]{32}$/.test(id))
    throw new AgentAccessError("Invalid agent credential.");
  return storageKey(["agent-tokens", id + ".json"]);
}
export async function createAgentToken(
  connectionId: string,
  owner: string,
  sessionId: string,
  scopes: AgentScope[],
  options: { expires_at?: string } = {},
) {
  const c = await readConnection(connectionId);
  if (!c || c.revokedAt || !ownsConnection(c, owner))
    throw new AgentAccessError("Connection is unavailable.", 403);
  if (
    !/^[a-f0-9]{32}$/.test(sessionId) ||
    !scopes.length ||
    scopes.some((s) => !AGENT_SCOPES.includes(s))
  )
    throw new AgentAccessError("Invalid token scope or session.", 400);
  if (
    options.expires_at !== undefined &&
    typeof options.expires_at !== "string"
  )
    throw new AgentAccessError(
      "Token expiry must be an ISO timestamp.",
      400,
      "invalid_request",
    );
  const expiresAt =
    options.expires_at === undefined
      ? Date.now() + DEFAULT_AGENT_TOKEN_TTL_MS
      : Date.parse(options.expires_at);
  if (
    !Number.isFinite(expiresAt) ||
    expiresAt <= Date.now() ||
    expiresAt > Date.now() + MAX_AGENT_TOKEN_TTL_MS
  )
    throw new AgentAccessError(
      "Token expiry must be in the future and within two hours.",
      400,
      "invalid_request",
    );
  const id = randomUUID().replaceAll("-", ""),
    secret = randomBytes(32).toString("hex"),
    token = `aegis_agt_${id}_${secret}`;
  const record: AgentToken = {
    id,
    hash: sha(token),
    connectionId,
    ownerHash: c.ownerHash,
    sessionId,
    scopes: [...new Set(scopes)],
    createdAt: new Date().toISOString(),
    expires_at: new Date(expiresAt).toISOString(),
  };
  await writeObjectOnce(key(id), record);
  return { token, record };
}
export async function authenticateAgent(
  token: string | undefined,
  scope?: AgentScope,
  tool?: string,
): Promise<AgentToken> {
  const match = /^aegis_agt_([a-f0-9]{32})_[a-f0-9]{64}$/.exec(token ?? "");
  if (!match) throw new AgentAccessError("Agent credential required.");
  const r = await readObject<AgentToken>(key(match[1]));
  if (
    !r ||
    !/^[a-f0-9]{64}$/.test(r.hash) ||
    !timingSafeEqual(
      Buffer.from(r.hash, "hex"),
      Buffer.from(sha(token!), "hex"),
    ) ||
    (await readObject(storageKey(["agent-revocations", r.id + ".json"])))
  )
    throw new AgentAccessError("Agent credential is invalid or revoked.");
  if (!(await readActiveSession(r.sessionId)))
    throw new AgentAccessError("Agent credential is invalid or revoked.");
  if (
    !Number.isFinite(Date.parse(tokenExpiry(r))) ||
    Date.parse(tokenExpiry(r)) <= Date.now()
  )
    throw new AgentAccessError(
      "Agent token expired. Ask the owner to issue a new short-lived token.",
      401,
      "token_expired",
      { tokenId: r.id, connectionId: r.connectionId },
    );
  const c = await readConnection(r.connectionId);
  if (!c || c.revokedAt || c.ownerHash !== r.ownerHash)
    throw new AgentAccessError("Connection is unavailable.", 403);
  await recordAgentUse(r, tool);
  if (scope && !hasAgentScope(r, scope))
    throw new AgentAccessError(
      "Agent scope is required: " + scope,
      403,
      "scope",
    );
  return r;
}
export async function listAgentTokens(connectionId: string, owner: string) {
  const c = await readConnection(connectionId);
  if (!c || !ownsConnection(c, owner))
    throw new AgentAccessError("Connection is unavailable.", 403);
  const records = await Promise.all(
    (await objectKeys(storageKey(["agent-tokens"]) + "/")).map((k) =>
      readObject<AgentToken>(k),
    ),
  );
  return Promise.all(
    records
      .filter(
        (r): r is AgentToken =>
          !!r && r.connectionId === connectionId && r.ownerHash === c.ownerHash,
      )
      .map(async (r) => {
        const revoked = await readObject<{ revokedAt: string }>(
          storageKey(["agent-revocations", r.id + ".json"]),
        );
        const usage = await readLog<{
          id: string;
          at: string;
          tool: string | null;
        }>(usagePrefix(r.id));
        return serializeAgentToken(
          { ...r, ...revoked },
          {
            last_used_at: usage.at(-1)?.body.at ?? null,
            last_tool:
              [...usage].reverse().find((e) => e.body.tool !== null)?.body
                .tool ?? null,
          },
        );
      }),
  );
}
export async function revokeAgentToken(
  connectionId: string,
  owner: string,
  id: string,
) {
  const connection = await readConnection(connectionId);
  if (!connection || connection.revokedAt || !ownsConnection(connection, owner))
    throw new AgentAccessError("Connection is unavailable.", 403, "scope");
  if (!/^[a-f0-9]{32}$/.test(id))
    throw new AgentAccessError("Token is unavailable.", 404, "invalid_request");
  const record = await readObject<AgentToken>(key(id));
  if (
    !record ||
    record.connectionId !== connectionId ||
    record.ownerHash !== connection.ownerHash
  )
    throw new AgentAccessError("Token is unavailable.", 404, "invalid_request");
  const k = storageKey(["agent-revocations", id + ".json"]);
  if (!(await readObject(k))) {
    try {
      await writeObjectOnce(k, { revokedAt: new Date().toISOString() });
    } catch (error) {
      if (!(await readObject(k))) throw error;
    }
  }
}

function usagePrefix(id: string) {
  return storageKey(["agent-usage", id]) + "/";
}
export async function recordAgentUse(token: AgentToken, tool?: string) {
  const body = {
    id: randomUUID(),
    at: new Date().toISOString(),
    tool: tool === undefined ? null : redactText(tool).slice(0, 120),
  };
  await appendLog(usagePrefix(token.id), body, (x) => x.id === body.id);
}

type TokenMetadataInput = Pick<
  AgentToken,
  "id" | "connectionId" | "scopes" | "createdAt" | "expires_at" | "revokedAt"
> & { last_used_at?: string | null; last_tool?: string | null };
export function tokenExpiry(
  record: Pick<AgentToken, "createdAt" | "expires_at">,
) {
  const at = Date.parse(record.createdAt) + DEFAULT_AGENT_TOKEN_TTL_MS;
  return (
    record.expires_at ??
    (Number.isFinite(at) ? new Date(at).toISOString() : "invalid")
  );
}
/** Whitelist at the serializer boundary; raw records are safe to pass directly. */
export function serializeAgentToken(
  record: TokenMetadataInput,
  usage?: { last_used_at: string | null; last_tool: string | null },
) {
  return {
    id: record.id,
    connectionId: record.connectionId,
    scopes: record.scopes,
    workflow_scopes: [
      ...new Set(record.scopes.map(workflowScope).filter(Boolean)),
    ],
    createdAt: record.createdAt,
    expires_at: tokenExpiry(record),
    ...(record.revokedAt ? { revokedAt: record.revokedAt } : {}),
    last_used_at: usage?.last_used_at ?? record.last_used_at ?? null,
    last_tool: usage?.last_tool ?? record.last_tool ?? null,
  };
}
