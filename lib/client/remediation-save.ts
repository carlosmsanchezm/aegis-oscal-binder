import type { RemediationRecord } from "@/lib/aegis/remediation-store";

type Changes = { planIds?: string[]; proposalIds?: string[]; assessmentKeys?: string[]; assessment?: boolean };
let tail: Promise<unknown> = Promise.resolve();

export class RemediationSaveError extends Error {
  readonly code: string;
  readonly storageUnset: boolean;
  constructor(message: string, code: string, storageUnset: boolean) {
    super(message);
    this.name = "RemediationSaveError";
    this.code = code;
    this.storageUnset = storageUnset;
  }
}

/** Preview with no durable store and no cookie key. A configured store that fails does not qualify. */
export function proposalKeptInTab(error: unknown): boolean {
  return error instanceof RemediationSaveError
    && error.storageUnset
    && (error.code === "SESSION_CONFIGURATION" || error.code === "DEMO_CONFIGURATION");
}

async function remediationSaveError(response: Response, fallback: string): Promise<RemediationSaveError> {
  let message = fallback;
  let code = "";
  let storageUnset = false;
  try {
    const body = await response.json() as { error?: { message?: string; code?: string; details?: { storageUnset?: boolean } } };
    if (body.error?.message) message = body.error.message;
    if (body.error?.code) code = body.error.code;
    storageUnset = body.error?.details?.storageUnset === true;
  } catch { /* Keep the fallback. */ }
  return new RemediationSaveError(message, code, storageUnset);
}

function mergeEntries(current: unknown[], next: unknown[], ids?: string[]): unknown[] {
  const idOf = (item: unknown) => (item as { id: string }).id;
  const changed = new Set(ids ?? next.map(idOf));
  return [...current.filter((item) => !changed.has(idOf(item))), ...next.filter((item) => changed.has(idOf(item)))];
}

/** Serialize requests across tabs, then merge only the entries this action edited.
 * The lock covers GET through PUT and Set-Cookie, including the first session request.
 * Browsers without Web Locks retain per-tab ordering; record cookies remain independent.
 */
export function saveRemediationRecord(next: RemediationRecord, changes?: Changes, headers: Record<string, string> = {}, onSessionScope?: (scope: string) => void): Promise<RemediationRecord> {
  const job = async () => {
    const loaded = await fetch(`/api/remediation?key=${encodeURIComponent(next.key)}`, { cache: "no-store", headers });
    if (!loaded.ok) throw await remediationSaveError(loaded, "Saved records could not be loaded. Retry saving before leaving.");
    const { record, sessionScope } = await loaded.json() as { record: RemediationRecord | null; sessionScope?: string };
    if (sessionScope) onSessionScope?.(sessionScope);
    const current = record ?? { key: next.key, assessment: null, assessments: {}, plans: [], proposals: [] };
    const assessmentKeys = changes?.assessmentKeys ?? Object.keys(next.assessments ?? {});
    const updates = Object.fromEntries(Object.entries(next.assessments ?? {}).filter(([item]) => assessmentKeys.includes(item)));
    const merged: RemediationRecord = {
      key: next.key,
      assessment: changes && !changes.assessment ? current.assessment : next.assessment,
      assessments: { ...current.assessments as object, ...updates },
      plans: mergeEntries(current.plans, next.plans, changes?.planIds),
      proposals: mergeEntries(current.proposals ?? [], next.proposals ?? [], changes?.proposalIds),
    };
    const response = await fetch("/api/remediation", {
      method: "PUT", headers: { ...headers, ...(sessionScope ? {"x-aegis-expected-session":sessionScope} : {}), "content-type": "application/json" }, cache: "no-store", body: JSON.stringify(merged),
    });
    if (!response.ok) throw await remediationSaveError(response, "Could not store the draft for this session.");
    return merged;
  };
  const locked = async (): Promise<RemediationRecord> => typeof navigator !== "undefined" && navigator.locks
    ? await navigator.locks.request("aegis-remediation-save", job)
    : job();
  const run = tail.then(locked, locked);
  tail = run.then(() => undefined, () => undefined);
  return run;
}
