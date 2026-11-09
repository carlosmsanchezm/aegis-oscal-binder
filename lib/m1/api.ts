import type { StoredFile, FileComparison } from "@/lib/digest-model";
import type { Stored, Result } from "./state";
// Keep this adapter free of fixture imports so native ESM test collection stays data free.
const SA1_HEADERS = { "x-aegis-workspace": "sa1-demo" };

export type Workspace = "planning" | "classic";

export type ApiFailure = { code: string; message: string; details: Record<string, unknown> | null };

export class M1RequestError extends Error {
  constructor(readonly status: number, readonly failure: ApiFailure | null) {
    super(failure?.message ?? `Request failed with ${status}`);
  }
}

/** Planning uses the planning session function; the classic editor uses its own session. */
export function apiPath(workspace: Workspace, path: string): string {
  const route = path.replace("/api/digest/stored", "/api/digest/files");
  return workspace === "planning" ? route.replace(/^\/api\//, "/api/demo/sa1/") : route;
}

export function apiHeaders(workspace: Workspace, json = false): Record<string, string> {
  return { ...(workspace === "planning" ? SA1_HEADERS : {}), ...(json ? { "content-type": "application/json" } : {}) };
}

export async function m1Json<T>(workspace: Workspace, path: string, init: { method?: "GET" | "POST"; body?: unknown } = {}): Promise<T> {
  const method = init.method ?? "GET";
  const response = await fetch(apiPath(workspace, path), {
    method,
    cache: "no-store",
    credentials: "same-origin",
    headers: apiHeaders(workspace, init.body !== undefined),
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const text = await response.text();
  let body: { ok?: boolean; error?: ApiFailure } & Record<string, unknown> = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new M1RequestError(response.status, null);
  }
  if (!response.ok || body.ok === false) throw new M1RequestError(response.status, body.error ?? null);
  // Adapt the existing file inventory and persisted comparison contract to the locked views.
  if (path === "/api/digest/stored") body.objects = ((body.files ?? []) as StoredFile[]).map(toStored);
  if (path === "/api/digest/verify") {
    if (body.result) body.result = toResult(body.result as FileComparison);
    body.results = Array.isArray(body.files) ? (body.files as FileComparison[]).map(toResult) : null;
  }
  return body as T;
}

/** Links between M1 screens keep the session the user came from. */
export function m1Href(workspace: Workspace, path: string, params: Record<string, string | null | undefined> = {}): string {
  const routes: Record<string, string> = { "/stored/evidence": "/stored-evidence", "/stored/audit": "/audit-trail", "/stored/regenerate": "/regenerate-export", "/stored/verify": "/verify-stored-files" };
  path = routes[path] ?? path;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value) query.set(key === "object" ? "objectKey" : key, value);
  if (workspace === "planning") query.set("workspace", "sa1-demo");
  const text = query.toString();
  return text ? `${path}?${text}` : path;
}

export function workspaceViewHref(workspace: Workspace, view: string): string {
  return workspace === "planning" ? `/planning?view=${view}` : `/workspace?editor=classic&view=${view}`;
}

/** Object identity wins; export and render selectors also make the destination explicit. */
export function regenerateHref(workspace: Workspace, object: Stored): string {
  return m1Href(workspace, "/stored/regenerate", {
    object: object.objectKey,
    ...(object.kind === "export" ? { exportId: object.exportId, render: object.role } : {}),
  });
}

export function toStored(file: StoredFile): Stored {
  return { ...file, exportId: file.exportId ?? null, role: file.kind === "evidence" ? "evidence" : file.render ?? "oscal", current: !file.kept, keptAt: file.keptAt ?? null,
    title: file.title ?? file.objectName, filename: file.filename ?? file.objectName };
}
export function toResult(file: FileComparison): Result { return { ...file, status: file.result }; }
