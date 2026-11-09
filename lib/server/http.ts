import { createHash } from "node:crypto";
import {reportBackendFailure} from "./backend-diagnostics";
import { dropCachedSession } from "@/lib/aegis/store";
import { durableStorageConfigured } from "@/lib/durable";
import { flushRetainedWrites, refreshRetained, runRetainedRequest } from "@/lib/retained-bytes";
import { boundaryDenial } from "@/lib/account/access";
import { AegisError, adoptCookieSession, adoptSession, runWithSession, sessionCookie, type PersistedState } from "@/lib/aegis";
import { SA1_COOKIE } from "@/lib/aegis/sa1-demo";
import { decodeSa1Snapshot, encodeSa1Snapshot, sa1SnapshotCookies } from "./sa1-snapshot";

export function jsonOk(body: Record<string, unknown>, status = 200): Response {
  return Response.json({ ok: true, ...body }, { status });
}

export function jsonError(error: unknown): Response {
  if (error instanceof AegisError) {
    return Response.json(
      { ok: false, error: { code: error.code, message: error.message, details: error.code === "DEMO_CONFIGURATION" || error.code === "SESSION_CONFIGURATION" ? { storageUnset: !durableStorageConfigured() } : error.details ?? null } },
      { status: error.status },
    );
  }
  console.error(error);
  return Response.json({ ok: false, error: { code: "INTERNAL", message: "Unexpected error", details: null } }, { status: 500 });
}

export async function readJson(req: Request): Promise<Record<string, unknown>> {
  if (req.headers.get("content-length") === "0") return {};
  const text = await req.text();
  if (!text.trim()) return {};
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new AegisError("BAD_REQUEST", "JSON object required", 400);
  }
  return parsed as Record<string, unknown>;
}

function requestIsSecure(req: Request): boolean {
  const forwarded = req.headers.get("x-forwarded-proto");
  if (forwarded) return forwarded.split(",")[0]?.trim() === "https";
  try {
    return new URL(req.url).protocol === "https:";
  } catch {
    return false;
  }
}

function storageFailure(error: unknown): Response | null {
  if (!(error instanceof Error)) return null;
  if (error.message === "Durable write failed.") {
    reportBackendFailure(error);
    return jsonError(new AegisError("STORE_FAILED", "Could not store the session.", 500));
  }
  if (error.message === "Durable read failed." || error.message === "Durable storage is not configured.") {
    reportBackendFailure(error);
    return jsonError(new AegisError("STORE_UNAVAILABLE", "Package storage is temporarily unavailable.", 503));
  }
  if (error.message === "Preview cannot use the production Blob store.") {
    return jsonError(new AegisError("STORE_UNAVAILABLE", error.message, 503));
  }
  return null;
}

function finish(response: Response, adopted?: { id: string; fresh: boolean }, secure = false): Response {
  response.headers.set("cache-control", "private, no-store");
  varyCookie(response);
  if (adopted?.fresh) {
    response.headers.append("set-cookie", sessionCookie(adopted.id, secure));
  }
  return response;
}

/** A missing demo key cannot be decrypted. Callers keep the session id and skip the snapshot. */
function readPlanningSnapshot(raw: string | null, sid: string | null): PersistedState | null {
  if (!sid) return null;
  try {
    return decodeSa1Snapshot(raw, sid);
  } catch (error) {
    if (error instanceof AegisError && error.code === "DEMO_CONFIGURATION") return null;
    throw error;
  }
}

/**
 * Remediation drafts use their own cookie, not the planning package snapshot.
 * A missing demo key must not discard a remediation response the handler already produced.
 */
function keepRemediationDespiteSnapshot(req: Request, error: unknown): boolean {
  if (durableStorageConfigured() || !(error instanceof AegisError) || error.code !== "DEMO_CONFIGURATION") return false;
  return new URL(req.url).pathname.startsWith("/api/remediation");
}

function varyCookie(response: Response): void {
  const vary = response.headers.get("vary");
  if (!vary) {
    response.headers.set("vary", "cookie");
    return;
  }
  const listed = vary.split(",").some((part) => part.trim().toLowerCase() === "cookie");
  if (!listed) response.headers.set("vary", `${vary}, cookie`);
}

/**
 * Bind the caller's session cookie before the handler runs. A request with no
 * cookie gets a new empty session and Set-Cookie on the way out, including when
 * the handler fails. Package routes must not run outside this wrapper.
 */
export async function withSession(req: Request, run: () => Promise<Response> | Response): Promise<Response> {
  const demo = req.headers.get("x-aegis-workspace") === "sa1-demo"
    || (req.method === "GET" && new URL(req.url).searchParams.get("workspace") === "sa1-demo");
  const rawCookies = req.headers.get("cookie");
  const demoCookie = rawCookies?.split(";").map((v) => v.trim()).find((v) => v.startsWith(`${SA1_COOKIE}=`));
  let adopted: Awaited<ReturnType<typeof adoptSession>>;
  try {
    // Unset durable storage is a cookie session. A configured store that fails still blocks.
    // Reads report "no snapshot" instead of throwing, so the fallback cannot wait for that error.
    if (demo && !durableStorageConfigured()) {
      const requested = demoCookie?.slice(SA1_COOKIE.length + 1) || null;
      const snapshot = readPlanningSnapshot(rawCookies, requested);
      adopted = adoptCookieSession(requested, snapshot);
    } else {
      adopted = await adoptSession(demo ? (demoCookie?.replace(`${SA1_COOKIE}=`, "aegis_sid=") ?? null) : rawCookies);
    }
  } catch (error) {
    const failure = storageFailure(error);
    if (!demo || !failure || durableStorageConfigured() || !(error instanceof Error) || error.message !== "Durable storage is not configured.") return finish(failure ?? jsonError(error));
    try {
      const requested = demoCookie?.slice(SA1_COOKIE.length + 1) || null;
      const snapshot = readPlanningSnapshot(rawCookies, requested);
      adopted = adoptCookieSession(requested, snapshot);
    } catch (fallbackError) {
      return finish(jsonError(fallbackError));
    }
  }
  const sessionScope=createHash("sha256").update(adopted.id).digest("hex");
  const expectedScope=req.headers.get("x-aegis-expected-session");
  if(expectedScope && expectedScope!==sessionScope){
    // A delayed write/read from an old tab must neither mutate a new session
    // nor replace its cookies after an on-device deletion.
    if(adopted.fresh)dropCachedSession(adopted.id);
    return finish(jsonError(new AegisError("SESSION_CHANGED","This browser session changed. Reload before saving this review.",409)));
  }
  let response: Response;
  try {
    // Claimed workspace boundaries check the member role. An unclaimed cookie is unchanged.
    const denial = await boundaryDenial(req, adopted.id);
    if (denial) {
      response = jsonError(denial);
    } else {
    if (demo && (!durableStorageConfigured() || adopted.fresh || adopted.session.orphaned)) {
      const snapshot = readPlanningSnapshot(rawCookies, adopted.id);
      if (snapshot) adopted.session.commit(snapshot);
    }
    response = await runRetainedRequest(async () => {
      let handlerError: unknown;
      try {
        await refreshRetained(adopted.session.state, adopted.session.ctx.root, adopted.session.id);
        return await runWithSession(adopted.session, () => run());
      } catch (error) {
        handlerError = error;
        throw error;
      } finally {
        try {
          await flushRetainedWrites();
        } catch (flushError) {
          if (!handlerError) throw flushError;
        }
      }
    }, adopted.session.id);
    await adopted.session.flush();
    if (demo) {
      try {
        const snapshot = encodeSa1Snapshot(adopted.session.state, adopted.id);
        if(req.method !== "GET" || adopted.fresh)for (const cookie of sa1SnapshotCookies(snapshot, requestIsSecure(req))) response.headers.append("set-cookie", cookie);
      } catch (error) {
        if (!keepRemediationDespiteSnapshot(req, error) && (!durableStorageConfigured() || !(error instanceof AegisError) || error.code !== "DEMO_CONFIGURATION")) throw error;
      }
    }
    }
  } catch (error) {
    if (durableStorageConfigured()) dropCachedSession(adopted.id);
    response = storageFailure(error) ?? jsonError(error);
  }
  response.headers.set("x-aegis-session-scope",sessionScope);
  response.headers.set("cache-control", "private, no-store");
  varyCookie(response);
  if (adopted.fresh) {
    const cookie = sessionCookie(adopted.id, requestIsSecure(req));
    response.headers.append("set-cookie", demo ? cookie.replace("aegis_sid=", `${SA1_COOKIE}=`) : cookie);
  }
  return response;
}
