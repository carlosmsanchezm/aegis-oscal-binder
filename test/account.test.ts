import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { after, before, describe, test } from "node:test";
import { randomBytes } from "node:crypto";
import { BUILDER_COOKIE } from "../lib/server/builder-store";
import { withSession } from "../lib/server/http";
import { claimedBuilderCookieName, builderMutationDenial } from "../lib/account/access";
import { acceptGoogleClaims, acceptMicrosoftClaims, authorizeUrl, IdentityRejected, setOAuthHooksForTests } from "../lib/account/oauth";
import { GET as signIn } from "../app/api/auth/signin/[provider]/route";
import { GET as callback } from "../app/api/auth/callback/[provider]/route";
import { POST as openWorkspace } from "../app/api/account/workspaces/[id]/open/route";
import { POST as inviteRoute } from "../app/api/account/invitations/route";
import { POST as testSession } from "../app/api/auth/test-session/route";
import { openAccount, sealAccount } from "../lib/account/session";
import { acceptInvitation, changeRole, createInvitation, createOrganization, createWorkspace, removeMember, upsertIdentity } from "../lib/account/store";
import { safeReturn } from "../lib/account/text";
import type { JWTPayload } from "jose";

const previous = {
  data: process.env.AEGIS_DATA_DIR,
  secret: process.env.AUTH_SECRET,
  google: process.env.AUTH_GOOGLE_ID,
  googleSecret: process.env.AUTH_GOOGLE_SECRET,
  microsoft: process.env.AUTH_MICROSOFT_ID,
  microsoftSecret: process.env.AUTH_MICROSOFT_SECRET,
  testFlag: process.env.AEGIS_AUTH_TEST,
  vercel: process.env.VERCEL,
};

describe("accounts", { concurrency: false }, () => {
  before(() => {
    process.env.AEGIS_DATA_DIR = mkdtempSync(`${tmpdir()}/aegis-accounts-`);
    process.env.AUTH_SECRET = "account-test-secret-value";
    delete process.env.VERCEL;
    delete process.env.AUTH_GOOGLE_ID;
    delete process.env.AUTH_GOOGLE_SECRET;
    delete process.env.AUTH_MICROSOFT_ID;
    delete process.env.AUTH_MICROSOFT_SECRET;
    delete process.env.AEGIS_AUTH_TEST;
  });
  after(() => {
    setOAuthHooksForTests(null);
    for (const [key, value] of Object.entries({
      AEGIS_DATA_DIR: previous.data,
      AUTH_SECRET: previous.secret,
      AUTH_GOOGLE_ID: previous.google,
      AUTH_GOOGLE_SECRET: previous.googleSecret,
      AUTH_MICROSOFT_ID: previous.microsoft,
      AUTH_MICROSOFT_SECRET: previous.microsoftSecret,
      AEGIS_AUTH_TEST: previous.testFlag,
      VERCEL: previous.vercel,
    })) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test("work-account rules and authorize URLs", () => {
    assert.equal(safeReturn("//evil.example"), "/account");
    assert.equal(safeReturn("/planning?view=map"), "/planning?view=map");
    assert.equal(claimedBuilderCookieName(), BUILDER_COOKIE);
    const google = { iss: "https://accounts.google.com", aud: "x", sub: "sub", email: "a@company.test", email_verified: true, hd: "company.test", nonce: "n", name: "A" } as JWTPayload;
    assert.equal(acceptGoogleClaims(google, "n").email, "a@company.test");
    assert.throws(() => acceptGoogleClaims({ ...google, hd: "" }, "n"), IdentityRejected);
    assert.throws(() => acceptGoogleClaims({ ...google, email: "a@gmail.com", hd: "gmail.com" }, "n"), IdentityRejected);
    const tenant = "11111111-1111-4111-8111-111111111111";
    const microsoft = { sub: "ms", email: "a@company.test", name: "A", nonce: "n", tid: tenant, iss: `https://login.microsoftonline.com/${tenant}/v2.0` } as JWTPayload;
    assert.equal(acceptMicrosoftClaims(microsoft, "n").provider, "microsoft");
    assert.throws(() => acceptMicrosoftClaims({ ...microsoft, tid: "9188040d-6c67-4c5b-b112-36a304b66dad", iss: "https://login.microsoftonline.com/9188040d-6c67-4c5b-b112-36a304b66dad/v2.0" }, "n"), IdentityRejected);
    process.env.AUTH_GOOGLE_ID = "google-client";
    process.env.AUTH_MICROSOFT_ID = "ms-client";
    const googleUrl = new URL(authorizeUrl("google", { origin: "https://binder.example", state: "state", nonce: "nonce", challenge: "challenge" }));
    assert.equal(`${googleUrl.origin}${googleUrl.pathname}`, "https://accounts.google.com/o/oauth2/v2/auth");
    assert.equal(googleUrl.searchParams.get("hd"), "*");
    assert.equal(googleUrl.searchParams.get("redirect_uri"), "https://binder.example/api/auth/callback/google");
    const microsoftUrl = new URL(authorizeUrl("microsoft", { origin: "https://binder.example", state: "state", nonce: "nonce", challenge: "challenge" }));
    assert.equal(`${microsoftUrl.origin}${microsoftUrl.pathname}`, "https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize");
    assert.equal(microsoftUrl.searchParams.get("redirect_uri"), "https://binder.example/api/auth/callback/microsoft");
    delete process.env.AUTH_GOOGLE_ID;
    delete process.env.AUTH_MICROSOFT_ID;
  });

  test("sign-in stays on the configuration page until the OAuth app is registered", async () => {
    const response = await signIn(new Request("http://127.0.0.1/api/auth/signin/google?return=/planning"), { params: Promise.resolve({ provider: "google" }) });
    assert.equal(response.status, 302);
    assert.match(response.headers.get("location") ?? "", /error=configuration/);
    assert.doesNotMatch(response.headers.get("location") ?? "", /accounts\.google\.com/);
  });

  test("the OAuth callback stores a work account and does not keep the password", async () => {
    process.env.AUTH_GOOGLE_ID = "google-client";
    process.env.AUTH_GOOGLE_SECRET = "google-secret";
    const start = await signIn(new Request("http://127.0.0.1/api/auth/signin/google?return=/account"), { params: Promise.resolve({ provider: "google" }) });
    const location = new URL(start.headers.get("location") ?? "");
    const oauth = start.headers.getSetCookie().find((cookie) => cookie.startsWith("aegis_oauth="))?.split(";")[0];
    assert.ok(oauth);
    setOAuthHooksForTests({
      exchange: async (_provider, body) => {
        assert.equal(body.get("grant_type"), "authorization_code");
        assert.equal(body.get("client_secret") != null, true);
        return "signed-token";
      },
      verify: async () => ({ provider: "google", subject: "google-subject", email: "owner@company.test", name: "Owner" }),
    });
    const done = await callback(new Request(`http://127.0.0.1/api/auth/callback/google?code=code&state=${location.searchParams.get("state")}`, { headers: { cookie: oauth } }), { params: Promise.resolve({ provider: "google" }) });
    assert.equal(done.status, 302);
    assert.match(done.headers.get("location") ?? "", /notice=no-org/);
    const account = done.headers.getSetCookie().find((cookie) => cookie.startsWith("aegis_account="));
    assert.match(account ?? "", /HttpOnly/);
    const token = account?.split(";")[0]?.slice("aegis_account=".length) ?? "";
    const session = await openAccount(token);
    assert.equal(session?.email, "owner@company.test");
    assert.equal(session?.provider, "google");
    delete process.env.AUTH_GOOGLE_ID;
    delete process.env.AUTH_GOOGLE_SECRET;
    setOAuthHooksForTests(null);
  });

  test("roles, invitations, and claimed boundaries are enforced on the server", async () => {
    const admin = await upsertIdentity({ provider: "microsoft", subject: "admin", email: "admin@example.test", name: "Admin Example" });
    const org = await createOrganization(admin, "Example Org");
    const viewerUser = await upsertIdentity({ provider: "google", subject: "viewer", email: "viewer@example.test", name: "Viewer Example" });
    const invited = await createInvitation({ orgId: org.id, actorId: admin.id, actorName: admin.name, email: viewerUser.email, role: "viewer" });
    await assert.rejects(() => acceptInvitation(invited.token, admin), /different account/);
    const joined = await acceptInvitation(invited.token, viewerUser);
    assert.equal(joined.role, "viewer");
    await assert.rejects(() => createInvitation({ orgId: org.id, actorId: viewerUser.id, actorName: viewerUser.name, email: "other@example.test", role: "engineer" }), /Only an admin/);
    await assert.rejects(() => removeMember(org.id, admin.id, admin.id), /cannot remove yourself/);
    await assert.rejects(() => changeRole(org.id, admin.id, admin.id, "viewer"), /cannot change your own role/);
    const planningSessionId = randomBytes(16).toString("hex");
    const packageSessionId = randomBytes(16).toString("hex");
    const builderOwner = randomBytes(32).toString("hex");
    const workspace = await createWorkspace({
      orgId: org.id,
      userId: admin.id,
      name: "Example boundary",
      claimBrowser: true,
      cookies: { planningSessionId, packageSessionId, builderOwner },
    });
    assert.equal(workspace.planningSessionId, planningSessionId);
    const adminCookie = `aegis_account=${await sealAccount({ uid: admin.id, email: admin.email, name: admin.name, provider: "microsoft" })}; aegis_org=${org.id}`;
    const viewerCookie = `aegis_account=${await sealAccount({ uid: viewerUser.id, email: viewerUser.email, name: viewerUser.name, provider: "google" })}; aegis_org=${org.id}`;
    const opened = await openWorkspace(new Request(`http://127.0.0.1/api/account/workspaces/${workspace.id}/open`, { method: "POST", headers: { cookie: adminCookie } }), { params: Promise.resolve({ id: workspace.id }) });
    const openedBody = await opened.text();
    assert.equal(opened.status, 200);
    assert.equal(openedBody.includes(builderOwner), false);
    assert.match(opened.headers.getSetCookie().join("\n"), new RegExp(builderOwner));
    const viewerWrite = await withSession(new Request("http://127.0.0.1/api/package", { method: "POST", headers: { cookie: `${viewerCookie}; aegis_sid=${packageSessionId}` } }), () => Response.json({ ok: true }));
    assert.equal(viewerWrite.status, 403);
    const viewerRead = await withSession(new Request("http://127.0.0.1/api/package", { headers: { cookie: `${viewerCookie}; aegis_sid=${packageSessionId}` } }), () => Response.json({ ok: true }));
    assert.equal(viewerRead.status, 200);
    const adminWrite = await withSession(new Request("http://127.0.0.1/api/package", { method: "POST", headers: { cookie: `${adminCookie}; aegis_sid=${packageSessionId}` } }), () => Response.json({ ok: true }));
    assert.equal(adminWrite.status, 200);
    const stranger = await withSession(new Request("http://127.0.0.1/api/package", { method: "POST", headers: { cookie: `aegis_sid=${packageSessionId}` } }), () => Response.json({ ok: true }));
    assert.equal(stranger.status, 401);
    const free = randomBytes(16).toString("hex");
    const unclaimed = await withSession(new Request("http://127.0.0.1/api/package", { method: "POST", headers: { cookie: `aegis_sid=${free}` } }), () => Response.json({ ok: true }));
    assert.equal(unclaimed.status, 200);
    const deniedBuilder = await builderMutationDenial(new Request("http://127.0.0.1/api/builder", { method: "POST", headers: { cookie: `${viewerCookie}; ${BUILDER_COOKIE}=${builderOwner}` } }));
    assert.equal(deniedBuilder?.status, 403);
    const viewerInvite = await inviteRoute(new Request("http://127.0.0.1/api/account/invitations", { method: "POST", headers: { cookie: viewerCookie, "content-type": "application/json" }, body: JSON.stringify({ email: "other@example.test", role: "engineer" }) }));
    assert.equal(viewerInvite.status, 403);
    assert.equal(process.env.AEGIS_AUTH_TEST, undefined);
    const hidden = await testSession(new Request("http://127.0.0.1/api/auth/test-session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "a@example.test", name: "A", provider: "google" }) }));
    assert.equal(hidden.status, 404);
  });
});
