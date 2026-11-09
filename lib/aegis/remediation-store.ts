import { assertCollectedRecord } from "./collected-closure";
import { normalizeStoredIssueTriage } from "./issue-actions";
import path from "node:path";
import { blobGetText, blobGetVersionedText, blobPutTextIfVersion, DurableConflictError, persistenceMode } from "../durable";
import { storageKey } from "../storage-key";
import { getStorage } from "../storage";
import { dataDir, findRepoRoot } from "./paths";

const SESSION_ID_RE = /^[a-f0-9]{32}$/;
const MAX_BODY = 1_000_000;
const MAX_RECORDS = 20;

export function remediationBlobPath(id: string): string {
  return storageKey(["sessions", id, "remediation.json"]);
}

export type RemediationRecord = {
  key: string;
  assessment: unknown;
  assessments: unknown;
  plans: unknown[];
  proposals?: unknown[];
  statementMappings?: unknown[];
  issueDrafts?: unknown[];
  issueTriage?: unknown[];
  pullRequests?: import("../github/pr-types").PullRequestLink[];
  releaseEvidence?: import("./release-evidence").ReleaseEvidence[];
};

type StoredRemediation = {
  savedAt: string;
  records: RemediationRecord[];
};

const tails = new Map<string, Promise<unknown>>();

function enqueue<T>(sessionId: string, job: () => Promise<T>): Promise<T> {
  const previous = tails.get(sessionId) ?? Promise.resolve();
  const run = previous.then(job, job);
  tails.set(
    sessionId,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

function remediationFile(root: string, id: string): string {
  return path.join(dataDir(root), "sessions", id, "remediation.json");
}

function parseStored(raw: string): StoredRemediation | null {
  try {
    const parsed = JSON.parse(raw) as StoredRemediation;
    if (
      !parsed ||
      typeof parsed.savedAt !== "string" ||
      !Array.isArray(parsed.records)
    )
      return null;
    return {
      ...parsed,
      records: parsed.records.map((record) =>
        record && typeof record === "object" && record.issueTriage !== undefined
          ? { ...record, issueTriage: normalizeStoredIssueTriage(record.issueTriage) }
          : record,
      ),
    };
  } catch {
    return null;
  }
}

async function readStored(
  sessionId: string,
  root: string,
): Promise<StoredRemediation | null> {
  if (!SESSION_ID_RE.test(sessionId)) return null;
  if (persistenceMode() === "blob") {
    const raw = await blobGetText(remediationBlobPath(sessionId));
    return raw == null ? null : parseStored(raw);
  }
  const file = remediationFile(root, sessionId);
  if (!getStorage().exists(file)) return null;
  return parseStored(getStorage().read(file).toString("utf8"));
}

export async function readRemediation(
  sessionId: string,
  root = findRepoRoot(),
): Promise<StoredRemediation | null> {
  return readStored(sessionId, root);
}

async function persistRecord(
  sessionId: string,
  record: RemediationRecord,
  root: string,
  current: StoredRemediation | null,
  serverPullRequests = false,
  serverReleaseEvidence = false,
  version?: {etag:string|null},
): Promise<StoredRemediation> {
  if (!SESSION_ID_RE.test(sessionId))
    throw new Error("Refusing to persist a session with a malformed id.");
  if (!record.key.trim() || record.key.length > 2000)
    throw new Error("Invalid remediation key.");
  if (!Array.isArray(record.plans))
    throw new Error("Remediation plans must be a list.");
  if (!serverPullRequests && !serverReleaseEvidence) await assertCollectedRecord(sessionId, record);

  const previous = current?.records.find(r => r.key === record.key);
  const next: RemediationRecord = {
    releaseEvidence: serverReleaseEvidence ? record.releaseEvidence ?? [] : previous?.releaseEvidence ?? [],
    pullRequests: serverPullRequests ? record.pullRequests ?? [] : previous?.pullRequests ?? [],
    key: record.key,
    assessment: record.assessment ?? null,
    assessments:
      record.assessments &&
      typeof record.assessments === "object" &&
      !Array.isArray(record.assessments)
        ? record.assessments
        : {},
    plans: record.plans.slice(0, 50),
    proposals: Array.isArray(record.proposals)
      ? record.proposals.slice(0, 50)
      : [],
    issueDrafts: [
      ...new Map(
        [
          ...(current?.records.find((r) => r.key === record.key)?.issueDrafts ??
            []),
          ...(record.issueDrafts ?? []),
        ].map((p) => [(p as { id: string }).id, p]),
      ).values(),
    ].slice(-50),
    issueTriage: [
      ...new Map(
        [
          ...normalizeStoredIssueTriage(current?.records.find((r) => r.key === record.key)?.issueTriage),
          ...normalizeStoredIssueTriage(record.issueTriage),
        ].map((p) => [(p as { id?: string }).id ?? JSON.stringify(p), p]),
      ).values(),
    ].slice(-200),
    ...(record.statementMappings === undefined
      ? {}
      : {
          statementMappings: Array.isArray(record.statementMappings)
            ? record.statementMappings.slice(0, 200)
            : [],
        }),
  };
  const records = [
    ...(current?.records ?? []).filter((item) => item.key !== next.key),
    next,
  ].slice(-MAX_RECORDS);
  const stored: StoredRemediation = {
    savedAt: new Date().toISOString(),
    records,
  };
  const body = JSON.stringify(stored);
  if (body.length > MAX_BODY)
    throw new Error("Remediation record exceeds the storage limit.");
  if (persistenceMode() === "blob") {
    if(!version)throw new Error("Conditional remediation version is required.");
    await blobPutTextIfVersion(remediationBlobPath(sessionId), body, version.etag);
  } else {
    getStorage().write(remediationFile(root, sessionId), body);
  }
  return stored;
}

async function mutateStored<T>(sessionId:string,root:string,job:(current:StoredRemediation|null,version?:{etag:string|null})=>Promise<T>):Promise<T>{
  if(!SESSION_ID_RE.test(sessionId))throw new Error("Refusing to persist a session with a malformed id.");
  if(persistenceMode()!=="blob")return job(await readStored(sessionId,root));
  for(let attempt=0;attempt<12;attempt++){
    try{
    const snapshot=await blobGetVersionedText(remediationBlobPath(sessionId));
    const current=snapshot?parseStored(snapshot.text):null;
    if(snapshot&&!current)throw new Error("Stored remediation is unavailable.");
    return await job(current,{etag:snapshot?.etag??null});}
    catch(error){if(!(error instanceof DurableConflictError))throw error;}
  }
  throw new Error("Concurrent remediation update limit reached; retry the request.");
}

export async function writeRemediationRecord(
  sessionId: string,
  record: RemediationRecord,
  root = findRepoRoot(),
): Promise<StoredRemediation> {
  return enqueue(sessionId, () => mutateStored(sessionId,root,(current,version)=>
    persistRecord(sessionId, record, root, current, false, false, version)),
  );
}
/** Run a read/modify/write against the latest record in the existing per-session queue. */
export async function updateRemediationRecord(
  sessionId: string,
  key: string,
  update: (record: RemediationRecord | null) => Promise<RemediationRecord>,
  root = findRepoRoot(),
  serverPullRequests = false,
  serverReleaseEvidence = false,
): Promise<StoredRemediation> {
  if (!SESSION_ID_RE.test(sessionId))
    throw new Error("Refusing to persist a session with a malformed id.");
  return enqueue(sessionId, () => mutateStored(sessionId,root,async(current,version) => {
    const record = await update(
        current?.records.find((r) => r.key === key) ?? null,
      );
    if (record.key !== key)
      throw new Error("Remediation update changed its key.");
    return persistRecord(sessionId, record, root, current, serverPullRequests, serverReleaseEvidence, version);
  }));
}
