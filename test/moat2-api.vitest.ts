import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { getStorage } from "../lib/storage";
import { retainDocumentBundle } from "../lib/oscal/export-artifact";
import { exportConnectionBundle } from "../lib/oscal/connection-export";
import {
  Session,
  runWithSession,
  dropCachedSession,
  endSession,
} from "../lib/aegis/store";
import { createConnection, retainEvent } from "../lib/server/builder-store";
import {
  createAgentToken,
  authenticateAgent,
  listAgentTokens,
} from "../lib/agent/agent-token";
import { createMcpServer } from "../lib/agent/mcp-server";
import { appendAgentActivity, getAgentActivity } from "../lib/agent/audit";
import { connectionRecords } from "../lib/agent/service";
import {
  connectionProposals,
  proposalKey,
  reviewVersion,
} from "../lib/agent/approvals";
import { issueDraft } from "../lib/aegis/issue-actions";
import {
  readRemediation,
  writeRemediationRecord,
} from "../lib/aegis/remediation-store";
import { objectKeys, readObject, writeObjectOnce } from "../lib/immutable-log";
import { canonicalSha256 } from "../lib/collector/aws/jcs";
import { storageKey } from "../lib/storage-key";
import { queryTimeline } from "../lib/timeline/store";
import { listConnectionExports } from "../lib/oscal/export-history";
import { GET as pingGet } from "../app/api/agent/ping/route";
import {
  GET as tokensGet,
  POST as tokensPost,
  DELETE as tokensDelete,
} from "../app/api/agent/tokens/route";
import { DELETE as tokenDelete } from "../app/api/agent/tokens/[id]/route";
import { GET as auditGet } from "../app/api/agent/audit/route";
import {
  GET as approvalsGet,
  POST as approvalsPost,
} from "../app/api/approvals/route";
import { GET as timelineGet } from "../app/api/timeline/route";
import { GET as chainsGet } from "../app/api/timeline/verify/route";
import { GET as manifestGet } from "../app/api/oscal/manifest/route";
import { GET as exportsGet } from "../app/api/oscal/exports/route";
import {
  GET as bundleGet,
  POST as bundlePost,
} from "../app/api/oscal/bundle/route";
import { GET as keyGet } from "../app/api/oscal/public-key/route";
import { GET as summaryGet } from "../app/api/agent/summary/route";
import original from "../fixtures/boutique-live/40446239616/event.json";
import retest from "../fixtures/boutique-live/40446815397/event.json";

let folder: string, previous: Record<string, string | undefined>;
const sessionIds: string[] = [];
const envKeys = [
  "AEGIS_DATA_DIR",
  "AEGIS_MANIFEST_SIGNING_KEY",
  "AEGIS_MANIFEST_PUBLIC_KEY",
];
beforeEach(() => {
  previous = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
  folder = mkdtempSync(path.join(os.tmpdir(), "moat2-recorded-"));
  process.env.AEGIS_DATA_DIR = folder;
  delete process.env.AEGIS_MANIFEST_SIGNING_KEY;
  delete process.env.AEGIS_MANIFEST_PUBLIC_KEY;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-27T04:00:00Z"));
});
afterEach(() => {
  for (const id of sessionIds.splice(0)) dropCachedSession(id);
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const k of envKeys) {
    if (previous[k] === undefined) delete process.env[k];
    else process.env[k] = previous[k];
  }
  rmSync(folder, { recursive: true, force: true });
});
/** Recorded Boutique copies are test-only. This helper emulates the private collector boundary. */
async function setup(
  mode: "uploaded" | "collected" | "collected-pair" = "uploaded",
) {
  const sessionId = randomBytes(16).toString("hex");
  sessionIds.push(sessionId);
  const session = Session.create(sessionId);
  session.commit(session.state);
  await session.flush();
  const c = await createConnection("Recorded Boutique Moat 2 unit test"),
    agent = await createAgentToken(c.connection.id, c.owner, sessionId, [
      "read",
      "draft",
      "triage",
      "retest",
      "close",
    ]),
    limited = await createAgentToken(c.connection.id, c.owner, sessionId, [
      "draft",
    ]);
  for (const event of mode === "collected-pair"
    ? [original, retest]
    : [original]) {
    const b = await retainEvent(
      c.connection.id,
      JSON.stringify(event),
      undefined,
      "browser-owner",
      mode !== "uploaded",
    );
    if (mode !== "uploaded")
      await writeObjectOnce(
        storageKey([
          "collector-receipts",
          sessionId,
          c.connection.id + "-" + b.id + ".json",
        ]),
        {
          connectionId: c.connection.id,
          receiptId: b.id,
          sessionId,
          runId: event.run.id,
          commit: event.subject.revision,
          collectedAt: new Date().toISOString(),
        },
      );
  }
  const records = await connectionRecords(agent.record),
    source = records.find((r) => r.artifactJobId === "40446239616")!,
    issue = source.reviewItems!.find((i) =>
      /frontend.*KSV-0020|KSV-0020.*frontend/.test(i.description),
    )!;
  const proposal = issueDraft(source, issue, {
    risk: "Recorded test finding requires review",
    action: "Proposed recorded test correction",
    verification: issue.scope.verification.join(" "),
  });
  await writeRemediationRecord(sessionId, {
    key: proposalKey(c.connection.id),
    assessment: null,
    assessments: {},
    plans: [],
    proposals: [],
    issueDrafts: [proposal],
  });
  return { ...c, ...agent, limited, sessionId, proposal, source, issue };
}
type Setup = Awaited<ReturnType<typeof setup>>;
function req(
  s: Setup,
  route: string,
  actor: "owner" | "agent" | "limited" | "none" | "bad" = "owner",
  method = "GET",
  body?: unknown,
) {
  const headers: Record<string, string> = {};
  if (actor === "owner")
    headers.cookie = `aegis_builder_owner=${s.owner}; aegis_sid=${s.sessionId}`;
  if (actor === "agent" || actor === "limited")
    headers.authorization =
      "Bearer " + (actor === "agent" ? s.token : s.limited.token);
  if (actor === "bad") {
    headers.authorization = "Bearer invalid";
    headers.cookie = `aegis_builder_owner=${s.owner}; aegis_sid=${s.sessionId}`;
  }
  if (body !== undefined) headers["content-type"] = "application/json";
  const url = new URL(route, "https://binder.example");
  if (!url.searchParams.has("connection"))
    url.searchParams.set("connection", s.connection.id);
  return new Request(url, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
const reads: [string, (req: Request) => Promise<Response>][] = [
  ["ping", pingGet],
  ["audit", auditGet],
  ["approvals", approvalsGet],
  ["timeline", timelineGet],
  ["chains", chainsGet],
  ["manifest", manifestGet],
  ["exports", exportsGet],
  ["bundle", bundleGet],
  ["summary", summaryGet],
];
const paths: Record<string, string> = {
  ping: "/api/agent/ping",
  audit: "/api/agent/audit",
  approvals: "/api/approvals",
  timeline: "/api/timeline",
  chains: "/api/timeline/verify",
  manifest: "/api/oscal/manifest",
  exports: "/api/oscal/exports",
  bundle: "/api/oscal/bundle",
  summary: "/api/agent/summary",
};
async function item(s: Setup) {
  const response = await approvalsGet(req(s, "/api/approvals"));
  expect(response.status).toBe(200);
  return (await response.json()).items.find(
    (i: { proposal_id: string }) => i.proposal_id === s.proposal.id,
  );
}
async function decide(
  s: Setup,
  stage: "plan" | "closure",
  decision: "confirm" | "reject",
  override: Record<string, unknown> = {},
) {
  const p = (await connectionProposals(s.connection.id, s.sessionId)).find(
    (x) => x.proposal.id === s.proposal.id,
  )!.proposal;
  return approvalsPost(
    req(s, "/api/approvals", "owner", "POST", {
      proposal_id: p.id,
      stage,
      decision,
      version: reviewVersion(p),
      name: "Recorded Reviewer",
      reason: "Reviewed the recorded finding and collector retest.",
      ...override,
    }),
  );
}
async function mcp(s: Setup, token = s.token) {
  const server = createMcpServer(() => token),
    [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "recorded-moat2-unit", version: "1" });
  await client.connect(b);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}
function signingKeys() {
  const k = generateKeyPairSync("ed25519");
  process.env.AEGIS_MANIFEST_SIGNING_KEY = Buffer.from(
    k.privateKey.export({ type: "pkcs8", format: "pem" }),
  ).toString("base64");
  process.env.AEGIS_MANIFEST_PUBLIC_KEY = Buffer.from(
    k.publicKey.export({ type: "spki", format: "pem" }),
  ).toString("base64");
}

describe("connection read route authorization", () => {
  it.each(reads)(
    "%s enforces auth, read scope, connection binding and no cookie fallback",
    async (name, handler) => {
      const s = await setup(),
        route = paths[name];
      expect((await handler(req(s, route, "none"))).status).toBe(403);
      const limited = await handler(req(s, route, "limited"));
      expect(limited.status).toBe(403);
      expect((await limited.json()).code).toBe("scope");
      expect((await handler(req(s, route, "bad"))).status).toBe(401);
      const other = await createConnection(
        "Other recorded test connection",
        s.owner,
      );
      expect(
        (
          await handler(
            req(s, route + "?connection=" + other.connection.id, "agent"),
          )
        ).status,
      ).toBe(403);
      const allowed = await handler(req(s, route, "agent"));
      expect(allowed.status).toBe(200);
      expect(allowed.headers.get("cache-control")).toContain("no-store");
      await endSession(s.sessionId);
      expect((await handler(req(s, route, "agent"))).status).toBe(401);
    },
  );
});

it("token collection issues hashed credentials and lists durable usage without secrets", async () => {
  const s = await setup();
  expect((await tokensGet(req(s, "/api/agent/tokens", "none"))).status).toBe(
    403,
  );
  expect((await tokensGet(req(s, "/api/agent/tokens", "agent"))).status).toBe(
    403,
  );
  const missing = await tokensPost(
    req(s, "/api/agent/tokens", "none", "POST", {
      connectionId: s.connection.id,
      scopes: ["read"],
    }),
  );
  expect(missing.status).toBe(403);
  const agentIssue = await tokensPost(
    req(s, "/api/agent/tokens", "agent", "POST", {
      connectionId: s.connection.id,
      scopes: ["read"],
    }),
  );
  expect(agentIssue.status).toBe(403);
  expect((await agentIssue.json()).code).toBe("needs_human");
  const created = await tokensPost(
    req(s, "/api/agent/tokens", "owner", "POST", {
      connectionId: s.connection.id,
      scopes: ["read"],
    }),
  );
  expect(created.status).toBe(201);
  const issued = await created.json();
  const stored = await readObject<{ hash: string }>(
    storageKey(["agent-tokens", issued.id + ".json"]),
  );
  expect(JSON.stringify(stored).includes(issued.token)).toBe(false);
  dropCachedSession(s.sessionId);
  expect((await authenticateAgent(issued.token)).id).toBe(issued.id);
  const sdk = await mcp(s);
  try {
    expect(
      (await sdk.client.callTool({ name: "get_package", arguments: {} }))
        .isError,
    ).not.toBe(true);
  } finally {
    await sdk.close();
  }
  const listed = await tokensGet(req(s, "/api/agent/tokens"));
  expect(listed.status).toBe(200);
  const body = await listed.json(),
    token = body.tokens.find((r: { id: string }) => r.id === s.record.id);
  expect(token.last_tool).toBe("get_package");
  expect(token.last_used_at).toBe("2026-10-27T04:00:00.000Z");
  expect(JSON.stringify(body).includes(s.token)).toBe(false);
  expect(JSON.stringify(body).includes(s.record.hash)).toBe(false);
  expect(JSON.stringify(body).includes(s.sessionId)).toBe(false);
  expect(JSON.stringify(body).includes(s.owner)).toBe(false);
});
it("per-token DELETE requires a browser owner and cannot revoke another connection token", async () => {
  const s = await setup(),
    context = { params: Promise.resolve({ id: s.record.id }) };
  expect(
    (
      await tokenDelete(
        req(s, "/api/agent/tokens/" + s.record.id, "none", "DELETE"),
        context,
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await tokenDelete(
        req(s, "/api/agent/tokens/" + s.record.id, "agent", "DELETE"),
        context,
      )
    ).status,
  ).toBe(403);
  const other = await createConnection("Other recorded token owner", s.owner),
    otherToken = await createAgentToken(
      other.connection.id,
      s.owner,
      s.sessionId,
      ["read"],
    );
  expect(
    (
      await tokenDelete(
        req(s, "/api/agent/tokens/" + otherToken.record.id, "owner", "DELETE"),
        { params: Promise.resolve({ id: otherToken.record.id }) },
      )
    ).status,
  ).toBe(404);
  const cross = req(s, "/api/agent/tokens/" + s.record.id, "owner", "DELETE");
  cross.headers.set("origin", "https://other.invalid");
  expect((await tokenDelete(cross, context)).status).toBe(403);
  expect(
    (
      await tokenDelete(
        req(s, "/api/agent/tokens/" + s.record.id, "owner", "DELETE"),
        context,
      )
    ).status,
  ).toBe(200);
  await expect(authenticateAgent(s.token)).rejects.toMatchObject({
    status: 401,
  });
  expect((await authenticateAgent(otherToken.token)).id).toBe(
    otherToken.record.id,
  );
});
it("legacy token DELETE remains owner-only and revokes the selected credential", async () => {
  const s = await setup(),
    body = { connectionId: s.connection.id, id: s.record.id };
  expect(
    (await tokensDelete(req(s, "/api/agent/tokens", "none", "DELETE", body)))
      .status,
  ).toBe(403);
  expect(
    (await tokensDelete(req(s, "/api/agent/tokens", "agent", "DELETE", body)))
      .status,
  ).toBe(403);
  expect(
    (await tokensDelete(req(s, "/api/agent/tokens", "owner", "DELETE", body)))
      .status,
  ).toBe(200);
  await expect(authenticateAgent(s.token)).rejects.toMatchObject({
    status: 401,
  });
});
it("ping tests the token connection and records usage without returning credentials", async () => {
  const s = await setup(),
    response = await pingGet(req(s, "/api/agent/ping", "agent"));
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body).toMatchObject({
    ok: true,
    connection_id: s.connection.id,
    authenticated_as: "agent",
  });
  expect(JSON.stringify(body).includes(s.token)).toBe(false);
  expect(
    (await listAgentTokens(s.connection.id, s.owner)).find(
      (t) => t.id === s.record.id,
    )?.last_tool,
  ).toBe("/api/agent/ping");
});
it("audit cursor preserves same-time entries, stable refusal messages and original hashes", async () => {
  const s = await setup();
  for (const code of ["scope", "needs_server_evidence", "needs_human"] as const)
    await appendAgentActivity(s.connection.id, {
      tokenId: s.record.id,
      tool: "attempt_close",
      inputs: {},
      result: "refused",
      refusalCode: code,
      refusalReason: "Plain-language refusal: " + code,
    });
  let cursor: string | null = null;
  const codes: string[] = [];
  for (let i = 0; i < 3; i++) {
    const response = await auditGet(
      req(s, "/api/agent/audit?limit=1" + (cursor ? "&since=" + cursor : "")),
    );
    expect(response.status).toBe(200);
    const page = await response.json(),
      row = page.entries[0],
      { hash, ...unsigned } = row;
    const { refusal,source_label, ...chained } = unsigned;
    expect(source_label).toEqual({kind:"agent",token_id:s.record.id});
    expect(canonicalSha256(chained)).toBe(hash);
    codes.push(refusal.code);
    expect(refusal.message.startsWith("Plain-language refusal")).toBe(true);
    cursor = page.cursor;
    expect(page.has_more).toBe(i < 2);
  }
  expect(codes).toEqual(["scope", "needs_server_evidence", "needs_human"]);
  const empty = await auditGet(req(s, "/api/agent/audit?since=" + cursor));
  expect((await empty.json()).entries).toHaveLength(0);
  expect((await auditGet(req(s, "/api/agent/audit?since=bad"))).status).toBe(
    400,
  );
  expect((await auditGet(req(s, "/api/agent/audit?limit=201"))).status).toBe(
    400,
  );
  const other = await createConnection("Same-owner cursor isolation", s.owner);
  expect(
    (
      await auditGet(
        req(
          s,
          "/api/agent/audit?connection=" +
            other.connection.id +
            "&since=" +
            cursor,
        ),
      )
    ).status,
  ).toBe(400);
});
it("MCP outcomes distinguish scope and collected-evidence refusals in the activity feed", async () => {
  const s = await setup(),
    sdk = await mcp(s),
    limited = await mcp(s, s.limited.token);
  try {
    expect(
      (await limited.client.callTool({ name: "get_package", arguments: {} }))
        .isError,
    ).toBe(true);
    expect(
      (
        await sdk.client.callTool({
          name: "attempt_close",
          arguments: { receiptId: s.source.releaseSha256, issueId: s.issue.id },
        })
      ).isError,
    ).toBe(true);
  } finally {
    await limited.close();
    await sdk.close();
  }
  const feed = await (await auditGet(req(s, "/api/agent/audit"))).json();
  expect(
    feed.entries
      .map((e: { refusal: { code: string } | null }) => e.refusal?.code)
      .filter(Boolean),
  ).toEqual(["scope", "needs_server_evidence"]);
});
it("timeline filters before pagination and rejects a cursor from the audit chain", async () => {
  const s = await setup("collected-pair");
  const first = await (
    await timelineGet(req(s, "/api/timeline?limit=1"))
  ).json();
  expect(first.entries).toHaveLength(1);
  expect(first.has_more).toBe(true);
  const second = await (
    await timelineGet(
      req(s, "/api/timeline?limit=1&since=" + first.next_cursor),
    )
  ).json();
  expect(second.entries).toHaveLength(1);
  expect(second.entries[0].sequence).toBeGreaterThan(first.entries[0].sequence);
  expect(second.has_more).toBe(false);
  const filtered = await (
    await timelineGet(req(s, "/api/timeline?limit=1&control=ZZ-999"))
  ).json();
  expect(filtered.entries).toHaveLength(0);
  expect(filtered.next_cursor).toBeNull();
  expect(filtered.has_more).toBe(false);
  await appendAgentActivity(s.connection.id, {
    tokenId: s.record.id,
    tool: "recorded-test",
    inputs: {},
    result: "recorded",
    refusalReason: null,
  });
  const audit = await (await auditGet(req(s, "/api/agent/audit"))).json();
  expect(
    (await timelineGet(req(s, "/api/timeline?since=" + audit.cursor))).status,
  ).toBe(400);
});
it.each(["agent-audit", "timeline"])(
  "combined verification reports a damaged %s chain separately",
  async (kind) => {
    const s = await setup();
    await appendAgentActivity(s.connection.id, {
      tokenId: s.record.id,
      tool: "recorded-test",
      inputs: {},
      result: "recorded",
      refusalReason: null,
    });
    const healthy = await (
      await chainsGet(req(s, "/api/timeline/verify"))
    ).json();
    expect(healthy).toMatchObject({
      valid: true,
      audit: { valid: true },
      evidence: { valid: true },
    });
    const key = (
        await objectKeys(storageKey([kind, s.connection.id]) + "/")
      )[0],
      row = await readObject<Record<string, unknown>>(key);
    writeFileSync(
      path.join(folder, key),
      JSON.stringify({ ...row, hash: "f".repeat(64) }),
    );
    const response = await chainsGet(req(s, "/api/timeline/verify"));
    expect(response.status).toBe(409);
    const result = await response.json();
    expect(result.valid).toBe(false);
    expect(result.audit.valid).toBe(kind !== "agent-audit");
    expect(result.evidence.valid).toBe(kind !== "timeline");
    const summary = await (
      await summaryGet(req(s, "/api/agent/summary"))
    ).json();
    expect(summary.history_complete).toBe(false);
    expect(summary.chains.valid).toBe(false);
    if (kind === "agent-audit") expect(summary.agent_actions).toBeNull();
    else expect(summary.closures_confirmed_by_named_people).toBeNull();
  },
);

it("recorded approvals accept a plan and confirm named closure only after collected retest", async () => {
  const s = await setup("collected-pair");
  expect((await item(s)).stage).toBe("plan");
  expect((await decide(s, "plan", "confirm")).status).toBe(200);
  expect((await item(s)).stage).toBe("closure");
  const confirmed = await decide(s, "closure", "confirm");
  expect(confirmed.status).toBe(200);
  expect((await confirmed.json()).proposal).toMatchObject({
    acceptance: "accepted",
    closureConfirmed: true,
    closure: { name: "Recorded Reviewer" },
  });
  expect(await item(s)).toBeUndefined();
  const reviews = (await queryTimeline(s.connection.id)).filter(
    (e) => e.body.kind === "human-review",
  );
  expect(reviews).toHaveLength(2);
  expect(reviews.at(-1)?.body.review).toMatchObject({
    stage: "closure",
    decision: "confirm",
    name: "Recorded Reviewer",
  });
  const sdk = await mcp(s);
  try {
    expect(
      (
        await sdk.client.callTool({
          name: "attempt_close",
          arguments: { receiptId: s.source.releaseSha256, issueId: s.issue.id },
        })
      ).isError,
    ).toBe(true);
  } finally {
    await sdk.close();
  }
  expect(
    (await getAgentActivity(s.connection.id)).at(-1)?.body.refusalCode,
  ).toBe("needs_human");
});
it.each(["name", "reason"])(
  "approval decisions require a nonblank %s",
  async (field) => {
    const s = await setup();
    const response = await decide(s, "plan", "confirm", { [field]: " " });
    expect(response.status).toBe(400);
    expect(
      (await readRemediation(s.sessionId))!.records[0].proposals,
    ).toHaveLength(0);
    expect(
      (await queryTimeline(s.connection.id)).some(
        (e) => e.body.kind === "human-review",
      ),
    ).toBe(false);
  },
);
it("approval POST rejects missing auth, agent impersonation and cross-origin owner mutations", async () => {
  const s = await setup(),
    i = await item(s),
    body = {
      proposal_id: i.proposal_id,
      stage: i.stage,
      decision: "confirm",
      version: i.version,
      name: "Reviewer",
      reason: "Reviewed test finding.",
    };
  expect(
    (await approvalsPost(req(s, "/api/approvals", "none", "POST", body)))
      .status,
  ).toBe(403);
  const denied = await approvalsPost(
    req(s, "/api/approvals", "agent", "POST", body),
  );
  expect(denied.status).toBe(403);
  expect((await denied.json()).code).toBe("needs_human");
  expect(
    (await approvalsPost(req(s, "/api/approvals", "limited", "POST", body)))
      .status,
  ).toBe(403);
  const cross = req(s, "/api/approvals", "owner", "POST", body);
  cross.headers.set("origin", "https://other.invalid");
  expect((await approvalsPost(cross)).status).toBe(403);
});
it("uploaded evidence and caller proof flags cannot confirm closure", async () => {
  const s = await setup();
  expect((await decide(s, "plan", "confirm")).status).toBe(200);
  const response = await decide(s, "closure", "confirm", {
    server_evidence_ready: true,
    evidence: { verdict: "pass" },
    closureConfirmed: true,
  });
  expect(response.status).toBe(409);
  expect((await response.json()).code).toBe("needs_server_evidence");
  const stored = (await readRemediation(s.sessionId))!.records[0].proposals as {
    closureConfirmed: boolean;
  }[];
  expect(stored.every((p) => !p.closureConfirmed)).toBe(true);
  expect(
    (await queryTimeline(s.connection.id)).filter(
      (e) => e.body.review?.stage === "closure",
    ),
  ).toHaveLength(0);
});
it("rejected reviews retain a named reason and return after the draft changes", async () => {
  const s = await setup();
  expect((await decide(s, "plan", "reject")).status).toBe(200);
  expect(await item(s)).toBeUndefined();
  const record = (await readRemediation(s.sessionId))!.records[0];
  expect(
    (record.proposals![0] as { review: { name: string; reason: string } })
      .review,
  ).toMatchObject({
    name: "Recorded Reviewer",
    reason: "Reviewed the recorded finding and collector retest.",
  });
  // A changed canonical draft has a new version, so its previous rejection does not silently apply.
  await writeRemediationRecord(s.sessionId, {
    ...record,
    issueDrafts: [
      { ...s.proposal, action: "Changed recorded draft for a new review" },
    ],
  });
  expect((await item(s)).stage).toBe("plan");
});
it("stale review versions and cross-connection proposals cannot be confirmed", async () => {
  const s = await setup(),
    i = await item(s),
    record = (await readRemediation(s.sessionId))!.records[0];
  await writeRemediationRecord(s.sessionId, {
    ...record,
    issueDrafts: [
      { ...s.proposal, action: "Updated draft invalidates the pending review" },
    ],
  });
  expect(
    (await decide(s, "plan", "confirm", { version: i.version })).status,
  ).toBe(409);
  expect(
    (
      await decide(s, "plan", "confirm", {
        proposal_id: "proposal:CM-6:other:scan-foreign",
      })
    ).status,
  ).toBe(404);
});
it("a failed timeline append blocks human approval persistence", async () => {
  const s = await setup(),
    key = (
      await objectKeys(storageKey(["timeline", s.connection.id]) + "/")
    )[0],
    row = await readObject<Record<string, unknown>>(key);
  writeFileSync(
    path.join(folder, key),
    JSON.stringify({ ...row, hash: "f".repeat(64) }),
  );
  expect((await decide(s, "plan", "confirm")).status).toBe(503);
  expect(
    (await readRemediation(s.sessionId))!.records[0].proposals,
  ).toHaveLength(0);
});
it("closure rejection leaves the accepted plan open and records a named timeline decision", async () => {
  const s = await setup("collected-pair");
  expect((await decide(s, "plan", "confirm")).status).toBe(200);
  expect((await decide(s, "closure", "reject")).status).toBe(200);
  expect(
    (await connectionProposals(s.connection.id, s.sessionId)).find(
      (x) => x.proposal.id === s.proposal.id,
    )?.proposal.closureConfirmed,
  ).toBe(false);
  expect(await item(s)).toBeUndefined();
  expect(
    (await queryTimeline(s.connection.id)).filter(e=>e.body.kind==="human-review").at(-1)?.body.review,
  ).toMatchObject({ stage: "closure", decision: "reject" });
});

it("manifest preview is JSON-only and does not create a past export", async () => {
  const s = await setup(),
    response = await manifestGet(req(s, "/api/oscal/manifest"));
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("application/json");
  expect(response.headers.get("content-disposition")).toBeNull();
  const body = await response.json();
  expect(body).toMatchObject({
    preview: true,
    export_id: null,
    manifest: { signing: { status: "unsigned" } },
  });
  expect(await listConnectionExports(s.connection.id)).toHaveLength(0);
});
it("public key publication is intentionally unauthenticated and never reads or returns private material", () => {
  signingKeys();
  const privateValue = process.env.AEGIS_MANIFEST_SIGNING_KEY!;
  process.env.AEGIS_MANIFEST_SIGNING_KEY =
    "invalid-private-setting-must-not-be-read";
  const response = keyGet();
  expect(response.status).toBe(200);
  return response.json().then((body) => {
    expect(body).toMatchObject({ status: "published", algorithm: "ed25519" });
    expect(/^[a-f0-9]{64}$/.test(body.keyId)).toBe(true);
    expect(body.publicKey === process.env.AEGIS_MANIFEST_PUBLIC_KEY).toBe(true);
    expect(JSON.stringify(body).includes(privateValue)).toBe(false);
  });
});
it("public key publication reports unset or private-key-shaped public configuration safely", async () => {
  expect(keyGet().status).toBe(503);
  signingKeys();
  process.env.AEGIS_MANIFEST_PUBLIC_KEY =
    process.env.AEGIS_MANIFEST_SIGNING_KEY;
  const response = keyGet();
  expect(response.status).toBe(503);
  const text = await response.text();
  expect(text.includes(process.env.AEGIS_MANIFEST_SIGNING_KEY!)).toBe(false);
  expect(text.includes("PRIVATE KEY")).toBe(false);
});
it("past exports retain a stable manifest, scoped download and freshly verified signed bytes", async () => {
  const s = await setup("collected-pair");
  signingKeys();
  const download = await bundleGet(req(s, "/api/oscal/bundle", "agent"));
  expect(download.status).toBe(200);
  const id = download.headers.get("x-aegis-export-id")!;
  expect(id).toBeTruthy();
  const originalBytes = Buffer.from(await download.arrayBuffer());
  const listed = await (await exportsGet(req(s, "/api/oscal/exports"))).json();
  expect(listed.exports).toHaveLength(1);
  expect(listed.exports[0]).toMatchObject({ id, signing_status: "signed" });
  const manifest = await (
    await manifestGet(req(s, "/api/oscal/manifest?export=" + id))
  ).json();
  expect(manifest).toMatchObject({
    preview: false,
    export_id: id,
    verification: { status: "valid", exitCode: 0 },
  });
  const replay = await bundleGet(req(s, "/api/oscal/bundle?export=" + id));
  expect(Buffer.from(await replay.arrayBuffer()).equals(originalBytes)).toBe(
    true,
  );
  const other = await createConnection(
    "Other recorded export connection",
    s.owner,
  );
  expect(
    (
      await manifestGet(
        req(
          s,
          "/api/oscal/manifest?connection=" +
            other.connection.id +
            "&export=" +
            id,
        ),
      )
    ).status,
  ).toBe(404);
  expect(
    (
      await bundleGet(
        req(
          s,
          "/api/oscal/bundle?connection=" +
            other.connection.id +
            "&export=" +
            id,
        ),
      )
    ).status,
  ).toBe(404);
  const zip = path.join(
    folder,
    storageKey(["connection-exports", s.connection.id, id + ".zip"]),
  );
  writeFileSync(zip, Buffer.concat([readFileSync(zip), Buffer.from("x")]));
  const damaged = await manifestGet(req(s, "/api/oscal/manifest?export=" + id));
  expect(damaged.status).toBe(409);
  expect((await damaged.json()).verification.status).toBe("invalid");
  expect(
    (await bundleGet(req(s, "/api/oscal/bundle?export=" + id))).status,
  ).toBe(503);
  const summary = await (await summaryGet(req(s, "/api/agent/summary"))).json();
  expect(summary.last_signed_export.verification.status).toBe("invalid");
});
it("legacy artifact downloads remain session-isolated and stateless POST rejects cross-origin writes", async () => {
  const s = await setup();
  expect(
    (
      await bundleGet(
        req(
          s,
          "/api/oscal/bundle?artifact=00000000-0000-0000-0000-000000000000",
        ),
      )
    ).status,
  ).toBe(404);
  const request = req(s, "/api/oscal/bundle", "owner", "POST", {
    document: {},
  });
  request.headers.set("origin", "https://other.invalid");
  expect((await bundlePost(request)).status).toBe(403);
});
it("proof summary reports measured actions, refusals, named closure, provenance and signed-export verification", async () => {
  const s = await setup("collected-pair");
  expect((await decide(s, "plan", "confirm")).status).toBe(200);
  expect((await decide(s, "closure", "confirm")).status).toBe(200);
  await pingGet(req(s, "/api/agent/ping", "agent"));
  await appendAgentActivity(s.connection.id, {
    tokenId: s.record.id,
    tool: "attempt_close",
    inputs: {},
    result: "refused",
    refusalCode: "needs_server_evidence",
    refusalReason: "Collect a retest first.",
  });
  signingKeys();
  expect((await bundleGet(req(s, "/api/oscal/bundle"))).status).toBe(200);
  const response = await summaryGet(req(s, "/api/agent/summary"));
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body).toMatchObject({
    agent_actions: { total: 2, by_tool: { ping: 1, attempt_close: 1 } },
    refusals_by_reason: { needs_server_evidence: 1 },
    closures_confirmed_by_named_people: {
      count: 1,
      items: [{ name: "Recorded Reviewer", currently_verified: true }],
    },
    evidence: { server_collected: { runs: 2 }, uploaded: { runs: 0 } },
    chains: { valid: true },
    last_signed_export: { verification: { status: "valid", exitCode: 0 } },
    history_start_date: "2026-10-27T04:00:00.000Z",
    history_complete: true,
  });
  expect(JSON.stringify(body).includes(s.token)).toBe(false);
});
it("proof summary labels caller imports as uploaded and leaves absent signed exports null", async () => {
  const s = await setup(),
    body = await (await summaryGet(req(s, "/api/agent/summary"))).json();
  expect(body.evidence).toMatchObject({
    server_collected: { runs: 0 },
    uploaded: { runs: 1 },
  });
  expect(body.last_signed_export).toBeNull();
  expect(body.closures_confirmed_by_named_people.count).toBe(0);
});

it("token usage starts null and preserves the last tool across later authentication", async () => {
  const s = await setup();
  let metadata = (await listAgentTokens(s.connection.id, s.owner)).find(
    (t) => t.id === s.record.id,
  )!;
  expect(metadata.last_used_at).toBeNull();
  expect(metadata.last_tool).toBeNull();
  await authenticateAgent(s.token, "read", "get_package");
  vi.setSystemTime(new Date("2026-10-27T04:00:01Z"));
  await authenticateAgent(s.token);
  metadata = (await listAgentTokens(s.connection.id, s.owner)).find(
    (t) => t.id === s.record.id,
  )!;
  expect(metadata.last_used_at).toBe("2026-10-27T04:00:01.000Z");
  expect(metadata.last_tool).toBe("get_package");
  const usage = await objectKeys(
    storageKey(["agent-usage", s.record.id]) + "/",
  );
  expect(usage.length).toBe(2);
  for (const key of usage)
    expect(readFileSync(path.join(folder, key), "utf8").includes(s.token)).toBe(
      false,
    );
});
it("approval query aggregates pending reviews across recorded findings", async () => {
  const s = await setup(),
    other = s.source.reviewItems!.find(
      (i) => i.id !== s.issue.id && i.scope.controls.length > 0,
    )!;
  const second = issueDraft(s.source, other, {
    risk: "Second recorded finding",
    action: "Second proposed correction",
    verification: other.scope.verification.join(" "),
  });
  const record = (await readRemediation(s.sessionId))!.records[0];
  await writeRemediationRecord(s.sessionId, {
    ...record,
    issueDrafts: [s.proposal, second],
  });
  const body = await (await approvalsGet(req(s, "/api/approvals"))).json();
  expect(body.items.map((i: { proposal_id: string }) => i.proposal_id)).toEqual(
    expect.arrayContaining([s.proposal.id, second.id]),
  );
});
it("expired collector proof cannot earn closure and remains visible as historical named review", async () => {
  const s = await setup("collected-pair");
  expect((await decide(s, "plan", "confirm")).status).toBe(200);
  expect((await decide(s, "closure", "confirm")).status).toBe(200);
  vi.setSystemTime(new Date("2026-11-27T04:00:00Z"));
  const summary = await (await summaryGet(req(s, "/api/agent/summary"))).json();
  expect(summary.closures_confirmed_by_named_people).toMatchObject({
    count: 1,
    items: [{ name: "Recorded Reviewer", currently_verified: false }],
  });
  const refused = await decide(s, "closure", "confirm");
  expect(refused.status).toBe(409);
  expect((await refused.json()).code).toBe("needs_server_evidence");
});
it("interrupted review projection is not counted as closure and retries reuse the logged choice", async () => {
  const s = await setup("collected-pair");
  expect((await decide(s, "plan", "confirm")).status).toBe(200);
  const storage = getStorage(),
    write = storage.write.bind(storage),
    spy = vi.spyOn(storage, "write").mockImplementation((location, body) => {
      if (location.endsWith("remediation.json"))
        throw new Error("Simulated projection failure");
      return write(location, body);
    });
  expect((await decide(s, "closure", "confirm")).status).toBe(503);
  spy.mockRestore();
  const pending = await (await summaryGet(req(s, "/api/agent/summary"))).json();
  expect(pending.closures_confirmed_by_named_people).toMatchObject({
    count: 0,
    unprojected_decisions: 1,
  });
  expect(
    (await decide(s, "closure", "confirm", { name: "Different Reviewer" }))
      .status,
  ).toBe(409);
  expect((await decide(s, "closure", "confirm")).status).toBe(200);
  const complete = await (
    await summaryGet(req(s, "/api/agent/summary"))
  ).json();
  expect(complete.closures_confirmed_by_named_people).toMatchObject({
    count: 1,
    unprojected_decisions: 0,
  });
  expect(
    (await queryTimeline(s.connection.id)).filter(
      (e) => e.body.review?.stage === "closure",
    ),
  ).toHaveLength(1);
});
it("legacy retained artifact download requires its original browser package session", async () => {
  const s = await setup(),
    bundle = await exportConnectionBundle(
      s.connection.id,
      s.sessionId,
      "https://binder.example",
      { retain: false },
    ),
    document = JSON.parse(
      Buffer.from(
        bundle.files.find((f) => f.path === "system-security-plan.json")!.bytes,
      ).toString("utf8"),
    );
  const retained = await runWithSession(Session.create(s.sessionId), () =>
    retainDocumentBundle(document, "ssp.json"),
  );
  expect(
    (await bundleGet(req(s, "/api/oscal/bundle?artifact=" + retained.id)))
      .status,
  ).toBe(200);
  const other = req(s, "/api/oscal/bundle?artifact=" + retained.id);
  other.headers.set(
    "cookie",
    `aegis_builder_owner=${s.owner}; aegis_sid=${"cd".repeat(16)}`,
  );
  sessionIds.push("cd".repeat(16));
  expect((await bundleGet(other)).status).toBe(404);
});

it("token revocation remains available when usage metadata is damaged", async () => {
  const s = await setup();
  await authenticateAgent(s.token, "read", "get_package");
  const key = (
      await objectKeys(storageKey(["agent-usage", s.record.id]) + "/")
    )[0],
    row = await readObject<Record<string, unknown>>(key);
  writeFileSync(
    path.join(folder, key),
    JSON.stringify({ ...row, hash: "f".repeat(64) }),
  );
  expect(
    (
      await tokenDelete(
        req(s, "/api/agent/tokens/" + s.record.id, "owner", "DELETE"),
        { params: Promise.resolve({ id: s.record.id }) },
      )
    ).status,
  ).toBe(200);
  await expect(authenticateAgent(s.token)).rejects.toMatchObject({
    status: 401,
  });
});

it("proof summary counts prototype-named activity labels as ordinary numeric keys", async () => {
  const s = await setup();
  for (const tool of ["constructor", "__proto__", "toString"])
    await appendAgentActivity(s.connection.id, {
      tokenId: s.record.id,
      tool,
      inputs: {},
      result: "refused",
      refusalCode: "scope",
      refusalReason: "The requested tool is not available.",
    });
  const response = await summaryGet(req(s, "/api/agent/summary"));
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.agent_actions.total).toBe(3);
  for (const tool of ["constructor", "__proto__", "toString"])
    expect(body.agent_actions.by_tool[tool]).toBe(1);
  expect(body.refusals_by_reason.scope).toBe(3);
});

it("token telemetry normalizes dynamic routes and redacts credential-shaped operation labels", async () => {
  const s = await setup(),
    request = req(s, "/api/agent/tokens/" + s.token, "agent", "DELETE");
  expect(
    (await tokenDelete(request, { params: Promise.resolve({ id: s.token }) }))
      .status,
  ).toBe(403);
  let metadata = (await listAgentTokens(s.connection.id, s.owner)).find(
    (t) => t.id === s.record.id,
  )!;
  expect(metadata.last_tool).toBe("/api/agent/tokens/:id");
  await authenticateAgent(s.token, undefined, s.token);
  await appendAgentActivity(s.connection.id, {
    tokenId: s.record.id,
    tool: s.token,
    inputs: {},
    result: "refused",
    refusalCode: "scope",
    refusalReason: "The operation is unavailable.",
  });
  metadata = (await listAgentTokens(s.connection.id, s.owner)).find(
    (t) => t.id === s.record.id,
  )!;
  expect(metadata.last_tool).toBe("[redacted]");
  expect(
    JSON.stringify(await getAgentActivity(s.connection.id)).includes(s.token),
  ).toBe(false);
  for (const key of await objectKeys(
    storageKey(["agent-usage", s.record.id]) + "/",
  ))
    expect(readFileSync(path.join(folder, key), "utf8").includes(s.token)).toBe(
      false,
    );
});
