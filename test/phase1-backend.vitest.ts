import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Session, dropCachedSession } from "../lib/aegis/store";
import { createConnection, retainEvent } from "../lib/server/builder-store";
import {
  createAgentToken,
  authenticateAgent,
  serializeAgentToken,
  hasAgentScope,
  DEFAULT_AGENT_TOKEN_TTL_MS,
  MAX_AGENT_TOKEN_TTL_MS,
  type AgentScope,
} from "../lib/agent/agent-token";
import { SCOPE_ALIASES } from "../lib/agent/scopes";
import { createMcpServer } from "../lib/agent/mcp-server";
import { connectionRecords } from "../lib/agent/service";
import {
  connectionProposals,
  proposalKey,
  reviewVersion,
} from "../lib/agent/approvals";
import { readRemediation } from "../lib/aegis/remediation-store";
import { writeObjectOnce, objectKeys, readObject } from "../lib/immutable-log";
import { storageKey } from "../lib/storage-key";
import {
  appendTimeline,
  queryTimeline,
  verifyTimeline,
} from "../lib/timeline/store";
import {
  upsertIdentity,
  createOrganization,
  createWorkspace,
  createInvitation,
  acceptInvitation,
} from "../lib/account/store";
import { sealAccount } from "../lib/account/session";
import type { Role } from "../lib/account/types";
import { GET as tokensGet } from "../app/api/agent/tokens/route";
import {
  GET as issuesGet,
  POST as issuesPost,
} from "../app/api/remediation/issues/route";
import {
  GET as approvalsGet,
  POST as approvalsPost,
} from "../app/api/approvals/route";
import { GET as timelineGet } from "../app/api/timeline/route";
import { GET as evidenceGet } from "../app/api/builder/evidence/[id]/route";
import { GET as builderGet } from "../app/api/builder/route";
import { POST as mcpPost } from "../app/api/mcp/route";
import original from "../fixtures/boutique-live/40446239616/event.json";
import retest from "../fixtures/boutique-live/40446815397/event.json";
let folder: string, previous: Record<string, string | undefined>;
const ids: string[] = [];
beforeEach(() => {
  previous = {
    AEGIS_DATA_DIR: process.env.AEGIS_DATA_DIR,
    AUTH_SECRET: process.env.AUTH_SECRET,
  };
  folder = mkdtempSync(path.join(os.tmpdir(), "phase1-recorded-"));
  process.env.AEGIS_DATA_DIR = folder;
  process.env.AUTH_SECRET = randomBytes(32).toString("hex");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-27T04:00:00Z"));
});
afterEach(() => {
  for (const id of ids.splice(0)) dropCachedSession(id);
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const [k, v] of Object.entries(previous)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(folder, { recursive: true, force: true });
});
/** Recorded Boutique artifacts are confined to unit tests; receipts emulate the private collector boundary. */
async function setup(
  collected = true,
  pair = true,
  owner?: string,
  sessionId?: string,
) {
  sessionId ??= randomBytes(16).toString("hex");
  ids.push(sessionId);
  const session = Session.create(sessionId);
  session.commit(session.state);
  await session.flush();
  const c = await createConnection("Recorded Phase 1 system", owner),
    agent = await createAgentToken(c.connection.id, c.owner, sessionId, [
      "read_findings",
      "draft_poam",
      "propose_triage",
      "request_retest",
      "request_closure_review",
    ]);
  for (const event of pair ? [original, retest] : [original]) {
    const b = await retainEvent(
      c.connection.id,
      JSON.stringify(event),
      undefined,
      "browser-owner",
      collected,
    );
    if (collected)
      await writeObjectOnce(
        storageKey([
          "collector-receipts",
          sessionId,
          c.connection.id + "-" + b.id + ".json",
        ]),
        {
          sessionId,
          connectionId: c.connection.id,
          receiptId: b.id,
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
  return { ...c, ...agent, sessionId, source, issue, accountCookie: "" };
}
type S = Awaited<ReturnType<typeof setup>>;
function req(
  s: S,
  pathName: string,
  actor: "owner" | "agent" | "none" = "owner",
  method = "GET",
  body?: unknown,
) {
  const url = new URL(pathName, "https://binder.example");
  if (
    !url.searchParams.has("connection") &&
    !url.pathname.endsWith("approvals")
  )
    url.searchParams.set("connection", s.connection.id);
  const headers: Record<string, string> = {};
  if (actor === "owner")
    headers.cookie =
      `aegis_builder_owner=${s.owner}; aegis_sid=${s.sessionId}` +
      (s.accountCookie ? `; aegis_account=${s.accountCookie}` : "");
  if (actor === "agent") headers.authorization = "Bearer " + s.token;
  if (body !== undefined) headers["content-type"] = "application/json";
  return new Request(url, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function claim(s: S, role: Role = "isso") {
  const admin = await upsertIdentity({
      provider: "google",
      subject: "admin-" + s.connection.id,
      email: "admin-" + s.connection.id + "@example.test",
      name: "Recorded workspace admin",
    }),
    org = await createOrganization(admin, "Recorded Phase 1 workspace");
  await createWorkspace({
    orgId: org.id,
    userId: admin.id,
    name: "Recorded test workspace",
    claimBrowser: true,
    cookies: {
      packageSessionId: s.sessionId,
      planningSessionId: null,
      builderOwner: s.owner,
    },
  });
  if (role === "admin") {
    s.accountCookie = await sealAccount({
      uid: admin.id,
      email: admin.email,
      name: admin.name,
      provider: admin.provider,
    });
    return admin;
  }
  const person = await upsertIdentity({
      provider: "google",
      subject: role + "-" + s.connection.id,
      email: role + "-" + s.connection.id + "@example.test",
      name: "Recorded reviewer",
    }),
    invitation = await createInvitation({
      orgId: org.id,
      actorId: admin.id,
      actorName: admin.name,
      email: person.email,
      role,
    });
  await acceptInvitation(invitation.token, person);
  s.accountCookie = await sealAccount({
    uid: person.id,
    email: person.email,
    name: person.name,
    provider: person.provider,
  });
  return person;
}
const draft = {
  risk: "Recorded scanner finding requires review.",
  action: "Proposed correction to the recorded frontend.",
  verification: "Rerun the recorded scanner for the original target.",
};
async function propose(
  s: S,
  action = "draft",
  extra: Record<string, unknown> = {},
) {
  return issuesPost(
    req(s, "/api/remediation/issues", "agent", "POST", {
      connectionId: s.connection.id,
      receiptId: s.source.releaseSha256,
      issueId: s.issue.id,
      action,
      ...(action === "draft" ? { draft } : {}),
      ...extra,
    }),
  );
}
async function reviews(s: S) {
  return (
    await (
      await approvalsGet(req(s, "/api/approvals?connection=" + s.connection.id))
    ).json()
  ).items;
}
async function decide(
  s: S,
  item: Record<string, unknown>,
  decision = "confirm",
) {
  return approvalsPost(
    req(s, "/api/approvals?connection=" + s.connection.id, "owner", "POST", {
      proposal_id: item.proposal_id,
      stage: item.stage,
      version: item.version,
      decision,
      name: "Typed ISSO name",
      reason: "Reviewed the recorded finding and retest.",
    }),
  );
}
async function sdk(s: S) {
  const server = createMcpServer(() => s.token),
    [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "recorded-phase1-test", version: "1" });
  await client.connect(b);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

it.each(Object.entries(SCOPE_ALIASES))(
  "workflow scope %s remains a compatible alias for %s",
  async (legacy, workflow) => {
    const s = await setup(false, false);
    for (const scope of [legacy, workflow]) {
      const t = await createAgentToken(s.connection.id, s.owner, s.sessionId, [
        scope as AgentScope,
      ]);
      expect(
        hasAgentScope(
          await authenticateAgent(t.token, legacy as AgentScope),
          workflow,
        ),
      ).toBe(true);
      expect(
        hasAgentScope(
          await authenticateAgent(t.token, workflow),
          legacy as AgentScope,
        ),
      ).toBe(true);
    }
  },
);
it("tokens expire in fifteen minutes by default, expose expiry and refuse expired use with a code", async () => {
  const s = await setup(false, false),
    metadata = serializeAgentToken(s.record);
  expect(Date.parse(metadata.expires_at) - Date.parse(s.record.createdAt)).toBe(
    DEFAULT_AGENT_TOKEN_TTL_MS,
  );
  const listed = await tokensGet(req(s, "/api/agent/tokens"));
  expect(
    (await listed.json()).tokens.find(
      (t: { id: string }) => t.id === s.record.id,
    ).expires_at,
  ).toBe(metadata.expires_at);
  vi.setSystemTime(new Date(Date.now() + DEFAULT_AGENT_TOKEN_TTL_MS));
  await expect(authenticateAgent(s.token)).rejects.toMatchObject({
    status: 401,
    code: "token_expired",
  });
  const response = await mcpPost(
    req(s, "/api/mcp", "agent", "POST", {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "triage_finding", arguments: { issueId: s.issue.id } },
    }),
  );
  expect(response.status).toBe(401);
  expect((await response.json()).code).toBe("token_expired");
  expect(
    (await queryTimeline(s.connection.id, { finding: s.issue.id })).some(
      (e) => e.body.reason_code === "token_expired",
    ),
  ).toBe(true);
});
it("legacy tokens receive bounded expiry and invalid lifetimes cannot mint credentials", async () => {
  const s = await setup(false, false),
    key = storageKey(["agent-tokens", s.record.id + ".json"]),
    raw = JSON.parse(readFileSync(path.join(folder, key), "utf8"));
  delete raw.expires_at;
  writeFileSync(path.join(folder, key), JSON.stringify(raw));
  vi.setSystemTime(new Date(Date.now() + DEFAULT_AGENT_TOKEN_TTL_MS));
  await expect(authenticateAgent(s.token)).rejects.toMatchObject({
    code: "token_expired",
  });
  for (const expires_at of [
    "invalid",
    new Date(Date.now() - 1).toISOString(),
    new Date(Date.now() + MAX_AGENT_TOKEN_TTL_MS + 1).toISOString(),
  ])
    await expect(
      createAgentToken(
        s.connection.id,
        s.owner,
        s.sessionId,
        ["read_findings"],
        { expires_at },
      ),
    ).rejects.toMatchObject({ status: 400 });
});
it("the token serializer itself strips all credential and session fields", async () => {
  const s = await setup(false, false),
    safe = serializeAgentToken(s.record),
    json = JSON.stringify(safe);
  for (const secret of [
    s.record.hash,
    s.sessionId,
    s.record.ownerHash,
    s.token,
  ])
    expect(json.includes(secret)).toBe(false);
  expect(Object.keys(safe)).not.toEqual(
    expect.arrayContaining(["hash", "sessionId", "ownerHash"]),
  );
});
it("no workflow capability grants acceptance, approval, closure or risk acceptance", async () => {
  const s = await setup();
  for (const scope of ["accept", "approve", "close_item", "accept_risk"])
    await expect(
      createAgentToken(s.connection.id, s.owner, s.sessionId, [
        scope as AgentScope,
      ]),
    ).rejects.toMatchObject({ status: 400 });
  const forbidden = await propose(s, "triage", {
    outcome: "accept-risk",
    reason: "Caller requests an unsupported outcome.",
  });
  expect(forbidden.status).toBe(400);
  expect((await forbidden.json()).code).toBe("invalid_request");
  const approvals = await approvalsPost(
    req(s, "/api/approvals?connection=" + s.connection.id, "agent", "POST", {
      name: "Agent typed a person",
      reason: "Caller claim",
    }),
  );
  expect(approvals.status).toBe(403);
  expect((await approvals.json()).code).toBe("needs_human");
  expect(
    (await queryTimeline(s.connection.id, { finding: s.issue.id })).some(
      (e) => e.body.reason_code === "invalid_request",
    ),
  ).toBe(true);
});
it("historical unsupported triage cannot be offered or confirmed through finding APIs", async () => {
  const s = await setup();
  const response = await propose(s, "triage", { outcome: "plan-it", reason: "Supported proposal" });
  expect(response.status).toBe(200);
  const { decision } = await response.json();
  const file = path.join(folder, "sessions", s.sessionId, "remediation.json");
  const historical = JSON.parse(readFileSync(file, "utf8"));
  const legacy = { ...decision, id: "triage:historical-removed", outcome: "accept-risk" };
  historical.records.find((r: {key: string}) => r.key === proposalKey(s.connection.id)).issueTriage.push(legacy);
  writeFileSync(file, JSON.stringify(historical));
  const findingResponse = await issuesGet(req(s, "/api/remediation/issues?finding=" + s.issue.id));
  expect(findingResponse.status).toBe(200);
  const findings = JSON.stringify(await findingResponse.json());
  expect(findings).toContain(decision.id);
  expect(findings).not.toContain(legacy.id);
  await claim(s);
  const pending = await reviews(s);
  expect(pending.map((item: {proposal_id: string}) => item.proposal_id)).toEqual([decision.id]);
  const refused = await decide(s, {proposal_id: legacy.id, stage: "triage", version: "0".repeat(64)});
  expect(refused.status).toBe(404);
  expect((await refused.json()).code).toBe("invalid_request");
  expect((await decide(s, pending[0])).status).toBe(200);
});
it("existing evidence APIs label every item from private collector receipts, not caller flags", async () => {
  const s = await setup(),
    owner = req(s, "/api/builder/evidence/" + s.source.releaseSha256);
  const response = await evidenceGet(owner, {
    params: Promise.resolve({ id: s.source.releaseSha256 }),
  });
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.source_label.kind).toBe("server-collected");
  expect(
    body.items.every(
      (i: { source_label: { kind: string } }) =>
        i.source_label.kind === "server-collected",
    ),
  ).toBe(true);
  const overview = await (await builderGet(req(s, "/api/builder"))).json();
  expect(
    overview.connections[0].history.every(
      (h: { artifacts: { source_label: { kind: string } }[] }) =>
        h.artifacts.every((a) => a.source_label.kind === "server-collected"),
    ),
  ).toBe(true);
  const imported = await setup(false, false);
  const raw = await (
    await evidenceGet(
      req(imported, "/api/builder/evidence/" + imported.source.releaseSha256),
      { params: Promise.resolve({ id: imported.source.releaseSha256 }) },
    )
  ).json();
  expect(raw.source_label).toMatchObject({
    kind: "person",
    identity_verification: "unverified",
  });
});
it("agent POA&M fields stay attached to their finding with the authenticated token as author", async () => {
  const s = await setup();
  const response = await propose(s, "draft", {
    source_label: { kind: "person" },
    author: "fake-person",
  });
  expect(response.status).toBe(200);
  const p = (await response.json()).proposal;
  expect(p).toMatchObject({
    source_label: { kind: "agent", token_id: s.record.id },
    acceptance: "proposed",
    closureConfirmed: false,
    agent_draft_fields: ["riskStatement", "action", "milestone.description"],
  });
  const items = await (
    await issuesGet(
      req(s, "/api/remediation/issues?finding=" + s.issue.id, "agent"),
    )
  ).json();
  expect(items.poam_items[0].source_label).toEqual({
    kind: "agent",
    token_id: s.record.id,
  });
  expect(items.findings[0].poam_items[0].id).toBe(p.id);
  const pending = (await reviews(s)).find(
    (i: { proposal_id: string }) => i.proposal_id === p.id,
  );
  expect(pending.source_label.token_id).toBe(s.record.id);
  expect(pending.approver_identity_verification).toBe("typed_unverified");
  expect((await decide(s, pending)).status).toBe(403);
});
it("an authenticated ISSO accepts the agent draft with a typed, unverified name and reason", async () => {
  const s = await setup();
  await propose(s);
  await claim(s);
  const item = (await reviews(s)).find(
      (i: { stage: string }) => i.stage === "plan",
    ),
    response = await decide(s, item);
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.proposal.acceptance).toBe("accepted");
  expect(body.review).toMatchObject({
    name: "Typed ISSO name",
    identity_verification: "typed_unverified",
    source_label: {
      kind: "person",
      name: "Typed ISSO name",
      identity_verification: "typed_unverified",
    },
  });
});
it.each(["admin", "isse", "system-owner", "engineer", "assessor"] as Role[])(
  "%s cannot act as the ISSO for an agent proposal",
  async (role) => {
    const s = await setup();
    await propose(s);
    await claim(s, role);
    const pending = (await reviews(s)).find(
      (i: { stage: string }) => i.stage === "plan",
    );
    const response = await decide(s, pending);
    expect(response.status).toBe(403);
  },
);
it("Fix now and Plan it remain version-bound agent proposals until ISSO review", async () => {
  const s = await setup();
  const response = await propose(s, "triage", {
    outcome: "fix-now",
    reason: "Propose fixing this recorded finding.",
  });
  expect(response.status).toBe(200);
  const proposal = (await response.json()).decision;
  expect(proposal).toMatchObject({
    acceptance: "proposed",
    source_label: { kind: "agent", token_id: s.record.id },
  });
  await claim(s);
  const pending = (await reviews(s)).find(
    (i: { stage: string }) => i.stage === "triage",
  );
  expect(pending).toMatchObject({
    workflow_step: "finding",
    required_role: "isso",
    outcome: "fix-now",
  });
  const accepted = await decide(s, pending);
  expect(accepted.status).toBe(200);
  expect((await accepted.json()).decision.acceptance).toBe("accepted");
  expect((await decide(s, pending)).status).toBe(409);
  expect(
    (await reviews(s)).some((i: { stage: string }) => i.stage === "triage"),
  ).toBe(false);
  const second = await propose(s, "triage", {
    outcome: "plan-it",
    reason: "Propose planning this recorded finding.",
  });
  expect(second.status).toBe(200);
  const next = (await reviews(s)).find(
    (i: { stage: string }) => i.stage === "triage",
  );
  expect((await decide(s, next, "reject")).status).toBe(200);
});
it("a triage proposal can attach only to the POA&M item for its finding", async () => {
  const s = await setup();
  const draftResponse = await propose(s),
    p = (await draftResponse.json()).proposal;
  expect(
    (
      await propose(s, "triage", {
        poamItemId: p.id,
        outcome: "plan-it",
        reason: "Plan this specific POA&M item.",
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await propose(s, "triage", {
        poamItemId: "proposal:CM-6:other:scan-foreign",
        outcome: "fix-now",
        reason: "Wrong item.",
      })
    ).status,
  ).toBe(409);
});
it("closure rejection returns to the recorded prior step and cannot silently requeue on read", async () => {
  const s = await setup();
  await propose(s);
  await claim(s);
  const plan = (await reviews(s)).find(
    (i: { stage: string }) => i.stage === "plan",
  );
  expect((await decide(s, plan)).status).toBe(200);
  const client = await sdk(s);
  try {
    expect(
      (
        await client.client.callTool({
          name: "attempt_close",
          arguments: { receiptId: s.source.releaseSha256, issueId: s.issue.id },
        })
      ).isError,
    ).not.toBe(true);
  } finally {
    await client.close();
  }
  const pending = (await reviews(s)).find(
    (i: { stage: string }) => i.stage === "closure",
  );
  expect(pending).toBeTruthy();
  const rejected = await decide(s, pending, "reject");
  expect(rejected.status).toBe(200);
  const result = await rejected.json();
  expect(result.proposal.workflowState).toBe(
    result.proposal.closure_review.prior_step,
  );
  expect(result.proposal.readyToClose).toBe(false);
  expect(
    (await reviews(s)).some((i: { stage: string }) => i.stage === "closure"),
  ).toBe(false);
  const reread = (await connectionProposals(s.connection.id, s.sessionId)).find(
    (p) => p.proposal.id === pending.proposal_id,
  )!.proposal;
  expect(reread.workflowState).toBe(result.proposal.workflowState);
  expect(reread.closure_review?.state).toBe("rejected");
  expect(reread.closureConfirmed).toBe(false);
  const history = await queryTimeline(s.connection.id, { finding: s.issue.id });
  expect(
    history.some(
      (e) =>
        e.body.reason_code === "closure_rejected" &&
        e.body.source_label?.kind === "person",
    ),
  ).toBe(true);
  expect((await verifyTimeline(s.connection.id)).valid).toBe(true);
});
it("server-collected evidence remains mandatory for ISSO closure confirmation", async () => {
  const s = await setup(false, false);
  await propose(s);
  await claim(s);
  const plan = (await reviews(s)).find(
    (i: { stage: string }) => i.stage === "plan",
  );
  expect((await decide(s, plan)).status).toBe(200);
  const p = (await connectionProposals(s.connection.id, s.sessionId))[0]
    .proposal;
  const response = await decide(
    s,
    { proposal_id: p.id, stage: "closure", version: reviewVersion(p) },
    "confirm",
  );
  expect(response.status).toBe(409);
  expect((await response.json()).code).toBe("needs_server_evidence");
});
it("Needs a decision aggregates systems and filters by system, role and workflow step", async () => {
  const s = await setup(),
    other = await setup(true, true, s.owner, s.sessionId);
  await propose(s);
  await propose(other, "triage", {
    outcome: "plan-it",
    reason: "Plan the other system finding.",
  });
  const all = await (await approvalsGet(req(s, "/api/approvals"))).json();
  expect(
    new Set(all.items.map((i: { connection_id: string }) => i.connection_id))
      .size,
  ).toBe(2);
  const selected = await (
    await approvalsGet(
      req(
        s,
        "/api/approvals?system=" +
          other.connection.id +
          "&role=ISSO&step=finding",
      ),
    )
  ).json();
  expect(selected.items).toHaveLength(1);
  expect(selected.items[0].stage).toBe("triage");
  expect(
    (await (await approvalsGet(req(s, "/api/approvals?role=assessor"))).json())
      .items,
  ).toHaveLength(0);
  expect(
    (await approvalsGet(req(s, "/api/approvals?role=unknown"))).status,
  ).toBe(400);
  expect((await approvalsGet(req(s, "/api/approvals", "none"))).status).toBe(
    403,
  );
  expect((await approvalsGet(req(s, "/api/approvals", "agent"))).status).toBe(
    403,
  );
});
it("item history records agent actions and refusals with source labels and reason codes", async () => {
  const s = await setup();
  await propose(s);
  await propose(s, "triage", {
    outcome: "accept-risk",
    reason: "Forbidden agent risk request.",
  });
  const response = await timelineGet(
    req(s, "/api/timeline?finding=" + s.issue.id),
  );
  expect(response.status).toBe(200);
  const page = await response.json();
  expect(page.verified).toBe(true);
  expect(
    page.entries.some(
      (e: { reason_code: string }) => e.reason_code === "poam_draft_proposed",
    ),
  ).toBe(true);
  expect(
    page.entries.some(
      (e: { reason_code: string }) => e.reason_code === "invalid_request",
    ),
  ).toBe(true);
  expect(
    page.entries
      .filter((e: { body: { kind: string } }) => e.body.kind === "agent-action")
      .every(
        (e: { source_label: { kind: string; token_id: string } }) =>
          e.source_label.kind === "agent" &&
          e.source_label.token_id === s.record.id,
      ),
  ).toBe(true);
});
it("timeline applies filters before paging and binds the cursor to its filters", async () => {
  const s = await setup(false, false);
  for (let i = 0; i < 5; i++)
    await appendTimeline(s.connection.id, {
      id: "phase1-filter-" + i,
      kind: "person-action",
      source: {},
      commit: "",
      observedAt: new Date().toISOString(),
      artifactSha256: [],
      controls: ["CM-6"],
      findings: [i % 2 ? "other" : "selected"],
      collected: false,
      summary: {},
    });
  const first = await (
    await timelineGet(req(s, "/api/timeline?finding=selected&limit=2"))
  ).json();
  expect(first.entries).toHaveLength(2);
  expect(first.has_more).toBe(true);
  const second = await (
    await timelineGet(
      req(
        s,
        "/api/timeline?finding=selected&limit=2&since=" + first.next_cursor,
      ),
    )
  ).json();
  expect(second.entries).toHaveLength(1);
  expect(second.has_more).toBe(false);
  expect(
    (
      await timelineGet(
        req(s, "/api/timeline?finding=other&since=" + first.cursor),
      )
    ).status,
  ).toBe(400);
});

it("a new agent draft revision cannot inherit an earlier person's acceptance", async () => {
  const s = await setup();
  await propose(s);
  await claim(s);
  const first = (await reviews(s)).find(
    (i: { stage: string }) => i.stage === "plan",
  );
  expect((await decide(s, first)).status).toBe(200);
  const response = await propose(s, "draft", {
    draft: {
      ...draft,
      action: "A different proposed correction requiring a fresh ISSO review.",
    },
  });
  expect(response.status).toBe(200);
  const next = (await reviews(s)).find(
    (i: { stage: string }) => i.stage === "plan",
  );
  expect(next).toBeTruthy();
  expect(next.version).not.toBe(first.version);
  expect((await decide(s, first)).status).toBe(409);
  const current = (
    await connectionProposals(s.connection.id, s.sessionId)
  ).find((p) => p.proposal.id === next.proposal_id)!.proposal;
  expect(current.acceptance).toBe("proposed");
  expect(current.action).toBe(
    "A different proposed correction requiring a fresh ISSO review.",
  );
});
it("POA&M history includes finding refusals and retains historical named closure across revisions", async () => {
  const s = await setup();
  const p = (await (await propose(s)).json()).proposal;
  await claim(s);
  expect(
    (
      await decide(
        s,
        (await reviews(s)).find((i: { stage: string }) => i.stage === "plan"),
      )
    ).status,
  ).toBe(200);
  const client = await sdk(s);
  try {
    await client.client.callTool({
      name: "attempt_close",
      arguments: { receiptId: s.source.releaseSha256, issueId: s.issue.id },
    });
  } finally {
    await client.close();
  }
  expect(
    (
      await decide(
        s,
        (await reviews(s)).find(
          (i: { stage: string }) => i.stage === "closure",
        ),
      )
    ).status,
  ).toBe(200);
  await propose(s, "triage", {
    outcome: "accept-risk",
    reason: "Forbidden request on this finding.",
  });
  const page = await (
    await timelineGet(
      req(s, "/api/timeline?finding=" + encodeURIComponent(p.id)),
    )
  ).json();
  expect(
    page.entries.some(
      (e: { reason_code: string }) => e.reason_code === "invalid_request",
    ),
  ).toBe(true);
  expect(
    page.entries.some(
      (e: { reason_code: string }) => e.reason_code === "closure_confirmed",
    ),
  ).toBe(true);
  await propose(s, "draft", {
    draft: { ...draft, action: "New draft after the prior recorded closure." },
  });
  const { GET: summaryGet } = await import("../app/api/agent/summary/route");
  const summary = await (await summaryGet(req(s, "/api/agent/summary"))).json();
  expect(summary.closures_confirmed_by_named_people).toMatchObject({
    count: 1,
    items: [{ name: "Typed ISSO name", currently_verified: false }],
  });
});

it("legacy save cannot bypass named version-bound ISSO review for an agent draft", async () => {
  const s = await setup(false, false),
    proposal = (await (await propose(s)).json()).proposal;
  await claim(s);
  const { decisionFromProposal } = await import("../lib/aegis/plan-proposal"),
    { PUT } = await import("../app/api/remediation/route");
  const response = await PUT(
    req(s, "/api/remediation", "owner", "PUT", {
      key: proposalKey(s.connection.id),
      assessment: null,
      assessments: {},
      plans: [],
      proposals: [decisionFromProposal(proposal, { acceptance: "accepted" })],
    }),
  );
  expect(response.status).toBe(409);
  expect((await response.json()).error.code).toBe("HUMAN_REVIEW_REQUIRED");
  expect(
    (await connectionProposals(s.connection.id, s.sessionId))[0].proposal
      .acceptance,
  ).toBe("proposed");
});
it("person review refusals appear in the finding's verified history", async () => {
  const s = await setup();
  await propose(s);
  const pending = (await reviews(s)).find(
    (i: { stage: string }) => i.stage === "plan",
  );
  expect((await decide(s, pending)).status).toBe(403);
  const history = await queryTimeline(s.connection.id, { finding: s.issue.id });
  expect(
    history.some(
      (e) =>
        e.body.source_label?.kind === "person" &&
        e.body.reason_code === "needs_human" &&
        e.body.summary.result === "refused",
    ),
  ).toBe(true);
  expect((await verifyTimeline(s.connection.id)).valid).toBe(true);
});

it("agent refusal of a triage approval stays linked to the underlying finding", async () => {
  const s = await setup();
  await propose(s, "triage", {
    outcome: "plan-it",
    reason: "Propose a plan for the recorded finding.",
  });
  const triage = (await reviews(s)).find(
    (i: { stage: string }) => i.stage === "triage",
  );
  const response = await approvalsPost(
    req(s, "/api/approvals?connection=" + s.connection.id, "agent", "POST", {
      proposal_id: triage.proposal_id,
      stage: "triage",
      version: triage.version,
      decision: "confirm",
      name: "Agent typed name",
      reason: "Not allowed.",
    }),
  );
  expect(response.status).toBe(403);
  const history = await queryTimeline(s.connection.id, { finding: s.issue.id });
  expect(
    history.some(
      (e) =>
        e.body.reason_code === "needs_human" &&
        e.body.source_label?.kind === "agent",
    ),
  ).toBe(true);
});

it("an ISSO can reject a requested closure review after its retest proof expires", async () => {
  const s = await setup();
  await propose(s);
  const person = await claim(s);
  expect(
    (
      await decide(
        s,
        (await reviews(s)).find((i: { stage: string }) => i.stage === "plan"),
      )
    ).status,
  ).toBe(200);
  const client = await sdk(s);
  try {
    await client.client.callTool({
      name: "attempt_close",
      arguments: { receiptId: s.source.releaseSha256, issueId: s.issue.id },
    });
  } finally {
    await client.close();
  }
  vi.setSystemTime(new Date("2026-11-27T04:00:00Z"));
  s.accountCookie = await sealAccount({
    uid: person!.id,
    email: person!.email,
    name: person!.name,
    provider: person!.provider,
  });
  const pending = (await reviews(s)).find(
    (i: { stage: string }) => i.stage === "closure",
  );
  expect(pending).toBeTruthy();
  expect(pending.server_evidence_ready).toBe(false);
  const refused = await decide(s, pending);
  expect(refused.status).toBe(409);
  expect((await refused.json()).code).toBe("needs_server_evidence");
  expect((await decide(s, pending, "reject")).status).toBe(200);
  expect(
    (await reviews(s)).some((i: { stage: string }) => i.stage === "closure"),
  ).toBe(false);
});

it("bounded audit text cannot detach a large draft refusal from its finding history", async () => {
  const s = await setup(false, false),
    { appendAgentActivity } = await import("../lib/agent/audit");
  await appendAgentActivity(s.connection.id, {
    tokenId: s.record.id,
    tool: "draft_plan",
    inputs: {
      issueId: s.issue.id,
      draft: {
        risk: "r".repeat(6000),
        action: "a".repeat(6000),
        verification: "v".repeat(6000),
      },
    },
    result: "refused",
    refusalReason: "This token cannot draft the POA&M item.",
    refusalCode: "scope",
  });
  const history = await queryTimeline(s.connection.id, { finding: s.issue.id });
  expect(
    history.some(
      (e) =>
        e.body.reason_code === "scope" && e.body.source_label?.kind === "agent",
    ),
  ).toBe(true);
  expect((await verifyTimeline(s.connection.id)).valid).toBe(true);
});
