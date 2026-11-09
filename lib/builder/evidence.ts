/** Provider-independent, bounded observations. No deployment or approval fields are invented. */
export const BUILDER_EVENT_SCHEMA = "aegis.evidence-event.v1";
export const BUILDER_BUNDLE_SCHEMA = "aegis.evidence-bundle.v1";
export const MAX_EVENT_BYTES = 512_000;

export type EvidenceEvent = {
  schema: typeof BUILDER_EVENT_SCHEMA;
  run: { id: string; url?: string; producer: string; observedAt: string };
  subject: { kind: "code" | "infrastructure" | "identity" | "network" | "process"; id: string; revision: string };
  checks: {
    id: string; version: string; description: string;
    requirement: { framework: string; reference: string; objective: string };
    verdict: "pass" | "fail" | "unknown";
    artifacts: string[]; validUntil: string;
  }[];
  artifacts: { name: string; mediaType: string; contentBase64: string; sha256: string }[];
  limitations: string[];
};

function obj(v: unknown, field: string): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`Invalid ${field}.`);
  return v as Record<string, unknown>;
}
function str(v: unknown, field: string, max = 1000): string {
  if (typeof v !== "string" || !v.trim() || v.length > max || /[\u0000-\u001f]/.test(v)) throw new Error(`Invalid ${field}.`);
  return v.trim();
}
function name(v: unknown, field: string): string {
  const text = str(v, field, 100);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(text) || text.includes("..")) throw new Error(`Invalid ${field}.`);
  return text;
}
function date(v: unknown, field: string): string {
  const text = str(v, field, 40);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(text) || !Number.isFinite(Date.parse(text))) throw new Error(`Invalid ${field}.`);
  // Round-trip the calendar portion so impossible dates cannot roll forward silently.
  if (new Date(text).toISOString().slice(0, 19) !== text.slice(0, 19)) throw new Error(`Invalid ${field}.`);
  return text;
}
function array(v: unknown, field: string, max: number): unknown[] {
  if (!Array.isArray(v) || !v.length || v.length > max) throw new Error(`Invalid ${field}.`);
  return v;
}

export function parseEvidenceEvent(input: unknown): EvidenceEvent {
  const event = obj(input, "event");
  if (event.schema !== BUILDER_EVENT_SCHEMA) throw new Error("Unsupported evidence schema.");
  const run = obj(event.run, "run"), subject = obj(event.subject, "subject");
  const observedAt = date(run.observedAt, "observation time");
  let url: string | undefined;
  if (run.url != null) {
    url = str(run.url, "run URL", 500);
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) throw new Error("Invalid run URL.");
  }
  if (!["code", "infrastructure", "identity", "network", "process"].includes(String(subject.kind))) throw new Error("Invalid subject kind.");
  const artifacts = array(event.artifacts, "artifacts", 30).map(raw => {
    const a = obj(raw, "artifact"), content = str(a.contentBase64, "artifact bytes", 450_000);
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(content)) throw new Error("Invalid artifact bytes.");
    const hash = str(a.sha256, "artifact digest", 64);
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("Invalid artifact digest.");
    const mediaType = str(a.mediaType, "artifact media type", 100);
    if (!/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(mediaType)) throw new Error("Invalid artifact media type.");
    return { name: name(a.name, "artifact name"), mediaType, contentBase64: content, sha256: hash };
  });
  const inventory = new Set(artifacts.map(a => a.name));
  if (inventory.size !== artifacts.length) throw new Error("Duplicate artifact names.");
  const checks = array(event.checks, "checks", 30).map(raw => {
    const c = obj(raw, "check"), r = obj(c.requirement, "requirement");
    if (!["pass", "fail", "unknown"].includes(String(c.verdict))) throw new Error("Invalid check verdict.");
    const artifactNames = array(c.artifacts, "check artifacts", 30).map(v => name(v, "check artifact"));
    if (new Set(artifactNames).size !== artifactNames.length || artifactNames.some(a => !inventory.has(a))) throw new Error("Check artifact is outside the retained inventory.");
    const validUntil = date(c.validUntil, "freshness deadline");
    if (Date.parse(validUntil) <= Date.parse(observedAt)) throw new Error("Freshness deadline must follow observation time.");
    return {
      id: name(c.id, "check ID"), version: str(c.version, "check version", 100), description: str(c.description, "check description"),
      requirement: { framework: str(r.framework, "framework", 200), reference: str(r.reference, "requirement reference", 200), objective: str(r.objective, "assessment objective") },
      verdict: c.verdict as "pass" | "fail" | "unknown", artifacts: artifactNames, validUntil,
    };
  });
  if (new Set(checks.map(c => c.id)).size !== checks.length) throw new Error("Duplicate check IDs.");
  if (!Array.isArray(event.limitations) || event.limitations.length > 30) throw new Error("Invalid limitations.");
  return {
    schema: BUILDER_EVENT_SCHEMA,
    run: { id: name(run.id, "run ID"), producer: str(run.producer, "producer", 200), observedAt, ...(url ? { url } : {}) },
    subject: { kind: subject.kind as EvidenceEvent["subject"]["kind"], id: str(subject.id, "subject ID", 500), revision: str(subject.revision, "subject revision", 200) },
    checks, artifacts, limitations: event.limitations.map(v => str(v, "limitation")),
  };
}

export type EvidenceBundle = {
  schema: typeof BUILDER_BUNDLE_SCHEMA;
  id: string; connectionId: string; receivedAt: string;
  /** Exact submitted bytes, retained for reproducible hashing. */
  rawEvent: string;
  event: EvidenceEvent;
  integrity: "verified";
  authentication: "connection-token" | "browser-owner";
};

export type CheckState = "pass" | "fail" | "unknown" | "stale" | "future" | "outdated";
export function freshnessLabel(state: string): string {
  return state === "stale" ? "Expired" : state === "future" ? "Future-dated" : state === "outdated" ? "Superseded" : "Within deadline";
}
export function checkState(event: Pick<EvidenceEvent, "run">, check: EvidenceEvent["checks"][number], now = Date.now()): CheckState {
  if (Date.parse(event.run.observedAt) > now + 300_000) return "future";
  if (Date.parse(check.validUntil) <= now) return "stale";
  return check.verdict;
}

/** Versions, criteria and subjects must match before two results can be compared. */
export function checkIdentity(event: EvidenceEvent, check: EvidenceEvent["checks"][number]): string {
  return JSON.stringify([event.subject.kind, event.subject.id, check.id, check.version, check.requirement]);
}

export function latestChecks(bundles: EvidenceBundle[], now = Date.now()) {
  const latest = new Map<string, { bundle: EvidenceBundle; check: EvidenceEvent["checks"][number]; state: CheckState; previous?: EvidenceBundle }>();
  const sorted = [...bundles].sort((a, b) => Date.parse(b.event.run.observedAt) - Date.parse(a.event.run.observedAt) || Date.parse(b.receivedAt) - Date.parse(a.receivedAt) || a.id.localeCompare(b.id));
  const currentSubjects = new Map<string, string>();
  const currentSpecs = new Map<string, string>();
  // A producer's future-dated report must not displace an actual current failure.
  for (const bundle of sorted.filter(b => Date.parse(b.event.run.observedAt) <= now + 300_000)) {
    for (const check of bundle.event.checks) {
      const key = checkIdentity(bundle.event, check), existing = latest.get(key);
      const subjectKey = JSON.stringify([bundle.event.subject.kind, bundle.event.subject.id]);
      if (!currentSubjects.has(subjectKey)) currentSubjects.set(subjectKey, bundle.event.subject.revision);
      const checkKey = JSON.stringify([subjectKey, check.id]);
      if (!currentSpecs.has(checkKey)) currentSpecs.set(checkKey, key);
      const outdated = currentSubjects.get(subjectKey) !== bundle.event.subject.revision || currentSpecs.get(checkKey) !== key;
      if (!existing) latest.set(key, { bundle, check, state: outdated ? "outdated" : checkState(bundle.event, check, now) });
      else if (!existing.previous && existing.bundle.event.subject.revision !== bundle.event.subject.revision) existing.previous = bundle;
    }
  }
  return [...latest.values()];
}
