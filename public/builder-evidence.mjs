#!/usr/bin/env node
// Dependency-free collector. Run in the workload's actual caller context.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const hash = value => createHash("sha256").update(value).digest("hex");
const args = argv => {
  const result = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!/^--[a-z-]+$/.test(argv[i]) || !argv[i + 1] || argv[i + 1].startsWith("--")) throw new Error("Options require --name value pairs.");
    result[argv[i].slice(2)] = argv[i + 1];
  }
  return result;
};
const required = (options, key) => { if (!options[key]) throw new Error(`Missing --${key}.`); return options[key]; };
const text = (value, label, max = 1000) => {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u001f]/.test(value)) throw new Error(`Invalid ${label}.`);
  return value;
};

async function probe(name, config) {
  const target = new URL(text(config?.url, "probe URL", 500));
  if (!["https:", "http:"].includes(target.protocol) || target.username || target.password || target.search || target.hash) throw new Error("Probe URLs must be HTTP(S), without credentials, query strings or fragments.");
  if (!Number.isInteger(config.expectedStatus) || config.expectedStatus < 100 || config.expectedStatus > 599) throw new Error("Invalid expected HTTP status.");
  const started = Date.now();
  try {
    const response = await fetch(target, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(5000) });
    await response.body?.cancel();
    return { name, url: target.href, expectedStatus: config.expectedStatus, observedStatus: response.status, verdict: response.status === config.expectedStatus ? "pass" : "fail", elapsedMs: Date.now() - started };
  } catch {
    // An outage or timeout is not proof that a security restriction is effective.
    return { name, url: target.href, expectedStatus: config.expectedStatus, observedStatus: null, verdict: "unknown", elapsedMs: Date.now() - started, error: "HTTP observation unavailable" };
  }
}

export async function checkAccess(options) {
  const config = JSON.parse(readFileSync(required(options, "config"), "utf8"));
  const subjectId = text(config.subject?.id, "subject ID", 500);
  const requirement = {
    framework: text(config.requirement?.framework, "framework", 200),
    reference: text(config.requirement?.reference, "reference", 200),
    objective: text(config.requirement?.objective, "objective"),
  };
  const revision = text(required(options, "revision"), "subject revision", 200);
  const runId = text(required(options, "run-id"), "run ID", 100);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(runId) || runId.includes("..")) throw new Error("Invalid run ID.");
  const allowedStatus = config.probes?.allowed?.expectedStatus, deniedStatus = config.probes?.denied?.expectedStatus;
  if (![200, 201, 204].includes(allowedStatus) || ![401, 403].includes(deniedStatus)) throw new Error("Expected allowed status must be 200/201/204 and denied status must be 401/403.");
  if (config.probes.allowed.url === config.probes.denied.url) throw new Error("Allowed and denied probes must use distinct URLs.");
  const seconds = config.freshnessSeconds ?? 3600;
  if (!Number.isInteger(seconds) || seconds < 60 || seconds > 86400) throw new Error("Freshness must be 60–86400 seconds.");
  let runUrl;
  if (options["run-url"]) {
    const u = new URL(options["run-url"]);
    if (u.protocol !== "https:" || u.username || u.password) throw new Error("Invalid run URL.");
    runUrl = u.href;
  }
  const observedAt = new Date().toISOString();
  const results = await Promise.all([probe("required-access", config.probes.allowed), probe("prohibited-access", config.probes.denied)]);
  const verdict = results.some(p => p.verdict === "fail") ? "fail" : results.some(p => p.verdict === "unknown") ? "unknown" : "pass";
  const measurement = {
    schema: "aegis.http-access-observation.v1", collectorVersion: "1.0.0", observedAt,
    subject: { kind: "network", id: subjectId, revision }, requirement, results, verdict,
  };
  const bytes = Buffer.from(JSON.stringify(measurement, null, 2));
  const event = {
    schema: "aegis.evidence-event.v1",
    run: { id: runId, producer: "aegis-http-access-collector/1.0.0", observedAt, ...(runUrl ? { url: runUrl } : {}) },
    subject: measurement.subject,
    checks: [{ id: "http-access-boundary", version: "1.0.0", description: "Required HTTP access succeeds and prohibited HTTP access is rejected.", requirement, verdict, artifacts: ["http-access.json"], validUntil: new Date(Date.parse(observedAt) + seconds * 1000).toISOString() }],
    artifacts: [{ name: "http-access.json", mediaType: "application/json", contentBase64: bytes.toString("base64"), sha256: hash(bytes) }],
    limitations: [
      "Point-in-time HTTP observations from this caller context; no general database, firewall or IAM coverage is inferred.",
      "Expected 401/403 responses test rejection behavior; their security mechanism and response provenance need reviewer examination.",
      "Collector identity is declared. Connection authentication and digest checks do not verify a signed producer identity or constitute independent assessor review.",
      "Requirement mapping is supplied by the operator and covers only the stated objective.",
    ],
  };
  writeFileSync(required(options, "out"), JSON.stringify(event, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ verdict, probes: results.map(p => ({ name: p.name, verdict: p.verdict, observedStatus: p.observedStatus })) }));
  return verdict === "pass" ? 0 : 2;
}

export async function publish(options) {
  const endpoint = new URL(required(options, "endpoint"));
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !(endpoint.protocol === "https:" || endpoint.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname))) throw new Error("Use an HTTPS endpoint (HTTP is allowed only on loopback).");
  const token = process.env.AEGIS_BUILDER_TOKEN;
  if (!token || !/^[a-f0-9]{64}$/.test(token)) throw new Error("Set AEGIS_BUILDER_TOKEN to the connection credential.");
  const raw = readFileSync(required(options, "file"), "utf8");
  if (Buffer.byteLength(raw) > 512000) throw new Error("Event exceeds 500 KB.");
  const response = await fetch(endpoint, { method: "POST", redirect: "error", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: raw, signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`Evidence publication rejected (HTTP ${response.status}).`);
  const receipt = await response.json();
  if (receipt.evidenceId !== hash(raw)) throw new Error("Receipt does not match submitted evidence.");
  console.log(JSON.stringify({ evidenceId: receipt.evidenceId, receivedAt: receipt.receivedAt }));
  return 0;
}

export function verify(options) {
  const b = JSON.parse(readFileSync(required(options, "file"), "utf8"));
  if (b.schema !== "aegis.evidence-bundle.v1" || typeof b.rawEvent !== "string" || hash(b.rawEvent) !== b.id) throw new Error("Evidence digest mismatch.");
  if (options["expected-id"] && options["expected-id"] !== b.id) throw new Error("Evidence does not match the independently recorded receipt ID.");
  const e = JSON.parse(b.rawEvent);
  if (e.schema !== "aegis.evidence-event.v1" || !Array.isArray(e.artifacts) || !e.artifacts.length || !Array.isArray(e.checks) || !e.checks.length) throw new Error("Invalid evidence manifest.");
  if (!b.event || !["schema", "run", "subject", "checks", "artifacts", "limitations"].every(k => Object.hasOwn(b.event, k)) || b.event.checks?.length !== e.checks.length || b.event.artifacts?.length !== e.artifacts.length) throw new Error("Invalid retained manifest.");
  // Raw input can contain unknown fields; compare every retained normalized field.
  const matches = (raw, normalized) => {
    if (Array.isArray(normalized)) return Array.isArray(raw) && raw.length === normalized.length && normalized.every((v, i) => matches(raw[i], v));
    if (normalized && typeof normalized === "object") return raw && typeof raw === "object" && Object.entries(normalized).every(([k, v]) => matches(raw[k], v));
    return typeof raw === "string" && typeof normalized === "string" ? raw.trim() === normalized : raw === normalized;
  };
  if (!matches(e, b.event)) throw new Error("Evidence manifest mismatch.");
  for (const a of e.artifacts) {
    if (typeof a.contentBase64 !== "string" || !/^[a-f0-9]{64}$/.test(a.sha256 ?? "")) throw new Error("Invalid artifact manifest.");
    const bytes = Buffer.from(a.contentBase64, "base64");
    if (bytes.toString("base64") !== a.contentBase64 || hash(bytes) !== a.sha256) throw new Error("Artifact digest mismatch.");
  }
  console.log(JSON.stringify({ integrity: "verified", evidenceId: b.id, artifacts: e.artifacts.length, producerIdentity: "not independently verified", receiptPinned: Boolean(options["expected-id"]) }));
  return 0;
}

export async function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv, options = args(rest);
  if (command === "check-access") return checkAccess(options);
  if (command === "publish") return publish(options);
  if (command === "verify") return verify(options);
  throw new Error("Usage: node builder-evidence.mjs check-access|publish|verify --option value ...");
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(code => { process.exitCode = code; }).catch(error => {
    // Never print arbitrary response bodies, credentials, URLs or model inputs.
    const message = error instanceof Error && !["SyntaxError", "TypeError"].includes(error.name) ? error.message : "Invalid configuration or unavailable endpoint.";
    console.error(message); process.exitCode = 1;
  });
}
