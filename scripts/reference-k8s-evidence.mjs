#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";

const hash = value => createHash("sha256").update(value).digest("hex");
const options = {};
for (let i = 2; i < process.argv.length; i += 2) options[process.argv[i].replace(/^--/, "")] = process.argv[i + 1];
const context = options.context, namespace = options.namespace;
if (!context?.startsWith("kind-aegis-boutique-") || !/^[a-z0-9-]+$/.test(namespace ?? "") || !options.revision || !options.out || !/^[a-z0-9-]+$/.test(options["run-id"] ?? "")) {
  console.error("Specify an isolated kind-aegis-boutique-* context, namespace, revision, run-id and out file."); process.exit(1);
}
const base = ["--context", context, "--namespace", namespace];
function kubectl(args, input) { return execFileSync("kubectl", [...base, ...args], { input, encoding: "utf8", timeout: 30_000, stdio: ["pipe", "pipe", "pipe"] }); }
try {
  const sa = `system:serviceaccount:${namespace}:frontend`;
  const impersonation = ["--as", sa, "--as-group", "system:serviceaccounts", "--as-group", `system:serviceaccounts:${namespace}`, "--as-group", "system:authenticated"];
  const request = { apiVersion: "authorization.k8s.io/v1", kind: "SelfSubjectAccessReview", spec: { resourceAttributes: { namespace, verb: "get", resource: "secrets", group: "" } } };
  const rawReview = kubectl([...impersonation, "create", "--raw", "/apis/authorization.k8s.io/v1/selfsubjectaccessreviews", "-f", "-"], JSON.stringify(request));
  const review = JSON.parse(rawReview);
  if (typeof review.status?.allowed !== "boolean" || review.status.evaluationError) throw new Error("Authorization observation unavailable.");
  const roles = JSON.parse(kubectl(["get", "roles,rolebindings", "-o", "json"]));
  const pods = JSON.parse(kubectl(["get", "pods", "-o", "json"]));
  // Retain only runtime identity/image facts, excluding environment values and mounted secrets.
  const inventory = pods.items.map(p => ({ name: p.metadata.name, uid: p.metadata.uid, namespace: p.metadata.namespace, serviceAccount: p.spec.serviceAccountName, phase: p.status.phase, containers: (p.status.containerStatuses ?? []).map(c => ({ name: c.name, image: c.image, imageID: c.imageID, ready: c.ready })) }));
  if (!inventory.some(p => p.serviceAccount === "frontend" && p.phase === "Running" && p.containers.some(c => c.ready && c.imageID))) throw new Error("Frontend workload identity is not observed ready.");
  const observedAt = new Date().toISOString(), verdict = review.status.allowed ? "fail" : "pass";
  const artifact = (name, value) => { const bytes = Buffer.from(value); return { name, mediaType: "application/json", contentBase64: bytes.toString("base64"), sha256: hash(bytes) }; };
  const event = {
    schema: "aegis.evidence-event.v1", run: { id: options["run-id"], producer: "aegis-kubernetes-reference-collector/1.0.0", observedAt, ...(options["run-url"] ? { url: options["run-url"] } : {}) },
    subject: { kind: "identity", id: sa, revision: `${options.revision}:rbac-${hash(JSON.stringify(roles)).slice(0, 12)}` },
    checks: [{ id: "frontend-secret-read", version: "1.0.0", description: "Frontend service account cannot get Kubernetes Secrets in the reference namespace.", requirement: { framework: "NIST SP 800-53 Rev 5", reference: "AC-6", objective: "The Online Boutique frontend service account has no get permission for Secrets in this namespace." }, verdict, artifacts: ["authorization-review.json", "namespace-rbac.json", "workload-inventory.json"], validUntil: new Date(Date.parse(observedAt) + 3600_000).toISOString() }],
    artifacts: [artifact("authorization-review.json", rawReview), artifact("namespace-rbac.json", JSON.stringify(roles, null, 2)), artifact("workload-inventory.json", JSON.stringify(inventory, null, 2))],
    limitations: [
      "Actual Kubernetes authorization API response using service-account impersonation and its standard groups. No Secret contents are retrieved.",
      "Scoped support for the stated AC-6 objective only; no full control, enhancement, baseline or framework satisfaction is inferred.",
      "Source revision is operator-declared; deployed image identities are retained, but source-to-image signatures and provenance are not verified.",
      "Local kind environment; cloud IAM, organizational controls and general network-policy enforcement are not assessed.",
      "Producer identity and mapping are declared. Retest execution and digests do not constitute independent assessor review.",
    ],
  };
  writeFileSync(options.out, JSON.stringify(event, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ verdict, subject: sa, canGetSecrets: review.status.allowed, workloadsObserved: inventory.length }));
  process.exitCode = verdict === "pass" ? 0 : 2;
} catch { console.error("Reference collection failed; no security pass is emitted."); process.exitCode = 1; }
