import {createHash} from "node:crypto";
import {isMap, isSeq, isScalar, LineCounter, parseAllDocuments, type Node} from "yaml";
import type {CollectedArtifact, EvidenceFact, EvidenceSource} from "./types";

export const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const LIMIT = 2_000_000;
function typeFor(path: string, text: string): string | null {
  if (/checksums?[^/]*\.txt$/i.test(path)) return "Release assets";
  if (/(^|\/)Dockerfile(?:\.[^/]*)?$/.test(path)) return "Dockerfiles";
  if (/(^|\/)(?:go\.(?:mod|sum)|package(?:-lock)?\.json|requirements[^/]*\.(?:txt|in)|[^/]+\.csproj|pom\.xml|build\.gradle|Cargo\.(?:toml|lock)|Gemfile(?:\.lock)?|poetry\.lock|pyproject\.toml)$/.test(path)) return "Dependencies";
  if (/\.(?:md|rst)$/.test(path)) return /(?:^|\/)SECURITY\.md$/i.test(path) ? "Security documentation" : "Documentation";
  if (/\.github\/(?:workflows|actions)\/.*\.ya?ml$/.test(path) || /(?:^|\/)(?:cloudbuild|\.gitlab-ci)\.ya?ml$/.test(path)) return "CI workflows";
  if (/\.json$/.test(path) && /"(?:bomFormat|spdxVersion|artifacts)"/.test(text) && /CycloneDX|SPDX|syft/.test(text)) return "SBOM";
  if (/\.json$/.test(path) && /"(?:Vulnerabilities|vulnerabilities|matches)"/.test(text)) return "Vulnerability scans";
  if (/\.json$/.test(path) && /"Misconfigurations"/.test(text)) return "Configuration scans";
  if (/\.json$/.test(path) && /"(?:signatures|predicateType|critical)"/.test(text)) return "Signatures and provenance";
  if (/\.(?:ya?ml|json|tf|toml|cue)$/.test(path)) {
    if (/kind:\s*["']?(?:ServiceMonitor|PodMonitor|PrometheusRule|OpenTelemetryCollector)\b/.test(text)) return "Monitoring configuration";
    if (/kind:\s*(?:ClusterRole|Role|RoleBinding|ClusterRoleBinding|ServiceAccount)\b/.test(text)) return "Service accounts and RBAC";
    if (/kind:\s*NetworkPolicy\b/.test(text)) return "Network policies";
    if (/kind:\s*(?:Deployment|DaemonSet|StatefulSet|Pod|Job|CronJob)\b/.test(text)) return "Kubernetes workloads";
    if (/kustomiz/i.test(path)) return "Kustomize configuration";
    if (/helm|charts?\//i.test(path)) return "Helm configuration";
    return "Configuration";
  }
  return null;
}

/** Never copy source lines wholesale: emit only typed, allowlisted facts and safe values. */
export function collectSource(source: EvidenceSource): CollectedArtifact | null {
  if (source.sourceKind === "aws-account") throw new Error("Use the AWS account collector for an aws-account source.");
  if (!source.path || source.path.startsWith("/") || source.path.split("/").some(p => p === "..") || /[\u0000-\u001f]/.test(source.path)) throw new Error("Use a relative source path.");
  const repo = new URL(source.repo);
  if (repo.protocol !== "https:" || repo.username || repo.password || repo.search || repo.hash) throw new Error("Use an HTTPS source URL without credentials.");
  if (source.sourceUrl) {const url=new URL(source.sourceUrl);if(url.protocol!=="https:" || url.username || url.password || url.search || url.hash) throw new Error("Use a source link without credentials.");}
  if (!/^[a-f0-9]{40,64}$/.test(source.commit) || !Number.isFinite(Date.parse(source.capturedAt))) throw new Error("Pin a source commit and capture time.");
  if (Buffer.byteLength(source.content) > LIMIT) throw new Error(`Source exceeds 2 MB: ${source.path}`);
  const type = typeFor(source.path, source.content);
  if (!type) return null;
  const facts: EvidenceFact[] = [];
  const add = (key: string, value: string | number | boolean, line: number, field: string, outcome?: "fail") => {
    if (field.length > 1000 || !/^[\w.\[\]$/:-]+$/.test(field)) return;
    if (typeof value === "string" && (!/^[\w./:@+*=();, -]{1,250}$/.test(value) || /password|token|private.key/i.test(value))) return;
    if (!facts.some(f => f.key === key && f.line === line && f.field === field)) facts.push({key, value, line, field, content: `${field} = ${value}`, ...(outcome ? {outcome} : {})});
  };
  const lines = source.content.split(/\r?\n/);
  const limitations = ["Coverage only; repository declarations do not prove deployed enforcement or control satisfaction.", "Only extracted facts are retained; source hash names the original bytes."];
  if (type === "Release assets") {
    lines.forEach((line,i)=>{const match=/^([a-f0-9]{64})\s+/.exec(line);if(match)add("release-checksum",match[1],i+1,`checksums[${i}]`);});
    limitations.push("Checksum material is present; downloaded binaries and publisher signatures were not verified by this parser.");
  } else if (type === "Dockerfiles") {
    lines.forEach((line, i) => {
      const from = /^FROM\s+(.+)/i.exec(line);
      const image = from?.[1].trim().split(/\s+/).find(token=>!token.startsWith("--"));
      if (image && !image.includes("$") && !image.includes("://") && /^[\w./:-]+(?:@sha256:[a-f0-9]{64})?$/.test(image)) {
        add("base-image",image,i+1,"FROM");
        const pin=/@sha256:([a-f0-9]{64})$/.exec(image);
        if(pin) add("pinned-base-image",pin[1],i+1,"FROM.digest");
      }
      const user = /^USER\s+(\S+)/i.exec(line);
      if (user) {
        const uid=user[1].split(":")[0],root=uid==="root" || /^0+$/.test(uid);
        add(root ? "root-user" : "non-root",user[1],i+1,"USER",root ? "fail" : undefined);
      }
    });
  } else if (type === "Dependencies") {
    if (/\.json$/.test(source.path)) {
      try {
        const manifest=JSON.parse(source.content);
        for(const field of ["dependencies","devDependencies","peerDependencies","optionalDependencies","packages"]) {
          const entries=manifest[field];
          if(entries && typeof entries==="object" && !Array.isArray(entries) && Object.keys(entries).length) {
            const line=Math.max(1,lines.findIndex(l=>new RegExp(`"${field}"\\s*:`).test(l))+1);
            add("dependency-manifest",Object.keys(entries).length,line,`$.${field}`);
          }
        }
      } catch {limitations.push("Dependency JSON could not be parsed; no declarations inferred.");}
    } else {
      const marker=/^\s*(?:require\b|gem\s+["']|\[(?:dev-|build-)?dependencies\]|dependencies\s*[={]|(?:implementation|testImplementation|runtimeOnly|compileOnly|classpath|api)\s+["'(]|<dependency>|<PackageReference\b|[^\s]+\s+v[0-9][^\s]*\s+h1:)/;
      const line=lines.findIndex(l=>marker.test(l) || (/requirements[^/]*\.(?:txt|in)$/.test(source.path) && /^\s*[A-Za-z0-9][\w.[\]-]*(?:\s*[<=>!~]|\s*$)/.test(l)));
      if(line>=0) add("dependency-manifest","Dependency declarations present; no vulnerability verdict",line+1,"dependency-declaration");
    }
  } else if (type === "Documentation" || type === "Security documentation") {
    lines.forEach((line, i) => {
      if (type === "Security documentation" && /vulnerab|security.*report|report.*security/i.test(line)) add("security-policy", "Vulnerability reporting instructions", i + 1, "documentation");
      if (/architecture|data.flow|microservices|service.*communicat/i.test(line)) add("architecture-doc", "Architecture or data flow description", i + 1, "documentation");
    });
  } else if (type === "SBOM" || type === "Vulnerability scans" || type === "Configuration scans" || type === "Signatures and provenance") {
    let report: any;
    try {report = JSON.parse(source.content);} catch {limitations.push("Report could not be parsed; no content claims made.");}
    if (report) {
      if (type === "SBOM") {
        const components = report.components ?? report.packages ?? report.artifacts;
        if (Array.isArray(components)) add("sbom", components.length, 1, report.components ? "$.components.length" : report.packages ? "$.packages.length" : "$.artifacts.length");
      }
      if (type === "Vulnerability scans") {
        const results = report.Results?.flatMap((r: any) => r.Vulnerabilities ?? []) ?? report.matches ?? report.vulnerabilities;
        if (Array.isArray(results)) add("vulnerability-scan", results.length, 1, report.Results ? "$.Results" : report.matches ? "$.matches" : "$.vulnerabilities", results.length ? "fail" : undefined);
      }
      if (type === "Configuration scans" && Array.isArray(report.Results)) {
        report.Results.forEach((result: any, ri: number) => (result.Misconfigurations ?? []).forEach((finding: any, fi: number) => {
          if (["FAIL","PASS","EXCEPTION"].includes(finding.Status)) {
            const field=`$.Results[${ri}].Misconfigurations[${fi}]`;
            add("configuration-scan",finding.Status,1,`${field}.Status`,finding.Status === "FAIL" ? "fail" : undefined);
            if(typeof finding.ID==="string") add("configuration-check",finding.ID,1,`${field}.ID`);
          }
        }));
      }
      if (type === "Signatures and provenance") {
        if (Array.isArray(report.signatures) || report.critical) add("signature", "Signature material present; not verified", 1, report.critical ? "$.critical" : "$.signatures");
        if (Array.isArray(report)) report.forEach((r,index)=>{if(r?.critical || Array.isArray(r?.signatures)) add("signature", "Signature material present; not verified", 1, `$[${index}].${r.critical ? "critical" : "signatures"}`);});
        if (typeof report.predicateType === "string") add("provenance", "Provenance predicate present; not verified", 1, "$.predicateType");
      }
    }
  } else {
    const counter = new LineCounter();
    const docs = parseAllDocuments(source.content, {lineCounter: counter, strict: true, uniqueKeys: true});
    const walk = (node: Node | null | undefined, path: string, context: string) => {
      if (path.length > 1000) return;
      if (isSeq(node)) {node.items.forEach((child, i) => walk(child as Node, `${path}[${i}]`, context)); return;}
      if (!isMap(node)) return;
      const kind = node.items.find(p => isScalar(p.key) && p.key.value === "kind");
      const local = kind && isScalar(kind.value) && typeof kind.value.value === "string" ? kind.value.value : context;
      for (const pair of node.items) {
        if (!isScalar(pair.key) || typeof pair.key.value !== "string") continue;
        const key = pair.key.value, field = path ? `${path}.${key}` : key;
        const line = counter.linePos(pair.key.range?.[0] ?? 0).line;
        const value = isScalar(pair.value) ? pair.value.value : null;
        // Kubernetes Secret bodies are never inspected, including encoded data.
        if (local === "Secret" && ["data", "stringData"].includes(key)) continue;
        if (key === "kind" && typeof value === "string") {
          if (["Deployment", "StatefulSet", "DaemonSet", "Pod", "Job", "CronJob"].includes(value)) add("workload", value, line, field);
          if (value === "ServiceAccount") add("service-account", value, line, field);
          if (["Role", "ClusterRole", "RoleBinding", "ClusterRoleBinding"].includes(value)) add("rbac", value, line, field);
          if (value === "NetworkPolicy") add("network-policy", value, line, field);
          if (["PeerAuthentication", "AuthorizationPolicy", "ServiceEntry", "Gateway"].includes(value)) add("mesh-policy", value, line, field);
          if (["ServiceMonitor", "PodMonitor", "PrometheusRule", "OpenTelemetryCollector"].includes(value)) add("monitor-config", value, line, field);
        }
        if (key === "runAsNonRoot" && typeof value === "boolean") add("non-root", value, line, field, value ? undefined : "fail");
        if (key === "runAsUser" && typeof value === "number") add(value === 0 ? "root-user" : "non-root", value, line, field, value === 0 ? "fail" : undefined);
        if (key === "readOnlyRootFilesystem" && typeof value === "boolean") add("read-only", value, line, field, value ? undefined : "fail");
        if (key === "allowPrivilegeEscalation" && typeof value === "boolean") add("escalation", value, line, field, value ? "fail" : undefined);
        if (key === "capabilities") add("capabilities", "Capabilities configuration present", line, field);
        if (key === "limits" && /resources/.test(field)) add("resource-limits", "Resource limits declared", line, field);
        if (["livenessProbe", "readinessProbe", "startupProbe"].includes(key)) add("probe", key, line, field);
        if (type === "CI workflows" && key === "branches") add("branch-filter", "Workflow branch trigger filter; protection not verified", line, field);
        if (key === "required_status_checks") add("required-checks", "Required checks declared; provider identity unverified", line, field);
        if (key === "secretKeyRef" || key === "secretRef" || key === "secretName") add("secret-reference", "Secret reference; value excluded", line, field);
        if (/tls|mtls/i.test(key) && (value === true || isMap(pair.value))) add("tls-config", "TLS configuration declared; enforcement unverified", line, field);
        if (/logLevel|logging|loglevel|log_format/i.test(key)) add("log-config", "Logging configuration declared", line, field);
        if (/prometheus|serviceMonitor|metrics|opentelemetry/i.test(key)) add("monitor-config", "Monitoring configuration declared", line, field);
        if (type === "CI workflows" && key === "permissions") add("workflow-permissions", "Workflow permissions declared", line, field);
        if (type === "CI workflows" && ["jobs","steps","stages","script"].includes(key) && ((isMap(pair.value) && pair.value.items.length) || (isSeq(pair.value) && pair.value.items.length) || (typeof value==="string" && value.trim()))) add("ci-workflow","Job or step declarations; execution unverified",line,field);
        if (type === "Kustomize configuration" && ["resources","bases","patches","components","images","configMapGenerator","secretGenerator"].includes(key) && (isMap(pair.value) || isSeq(pair.value))) add("kustomize","Kustomize declarations; rendering unverified",line,field);
        if (type === "CI workflows" && key === "uses" && typeof value === "string") {
          if (/@[a-f0-9]{40}$/.test(value)) add("pinned-action", value, line, field);
          else if (!value.startsWith("./")) add("unpinned-action", "Action revision is mutable", line, field);
        }
        if (type === "CI workflows" && (key === "run" || key === "uses" || key === "name") && typeof value === "string") {
          if (/trivy|grype|sast|cve.scan|dependency.review/i.test(value)) add("scan-step", "Scan step declared; execution unverified", line, field);
          if (/cosign|attest|notation sign/i.test(value)) add("signing-step", "Signing or attestation step declared; execution unverified", line, field);
          if (/go test|npm test|pytest|test.*action/i.test(value)) add("test-step", "Test step declared; execution unverified", line, field);
          if (/\bsecrets\./.test(value)) add("secret-reference", "CI secret reference; value excluded", line, field);
        }
        walk(pair.value as Node, field, local);
      }
    };
    const valid = !(type !== "CI workflows" && source.content.includes("{{")) && docs.every(d => !d.errors.length);
    if (valid) docs.forEach((d, i) => walk(d.contents as Node, `document[${i}]`, ""));
    else {
      limitations.push("Unrendered template or unsupported syntax; only explicit scalar declarations extracted. No deployed configuration inferred.");
      lines.forEach((line, i) => {
        const monitor = /^\s*kind:\s*["']?(ServiceMonitor|PodMonitor|PrometheusRule|OpenTelemetryCollector)["']?\s*(?:#.*)?$/.exec(line);
        if (monitor) add("monitor-config", monitor[1], i + 1, "template.kind");
        const match = /^\s*(runAsNonRoot|readOnlyRootFilesystem|allowPrivilegeEscalation):\s*(true|false)\s*(?:#.*)?$/.exec(line);
        if (match) add({runAsNonRoot:"non-root",readOnlyRootFilesystem:"read-only",allowPrivilegeEscalation:"escalation"}[match[1]]!, match[2] === "true", i + 1, `template.${match[1]}`);
      });
    }
    lines.forEach((line,i)=>{if (/--log(?:-level|level|-format)\b/.test(line)) add("log-config","Logging argument declared",i+1,"container-argument");});
    if (type === "Helm configuration") {
      const line=lines.findIndex(l=>/^\s*[\w.-]+:\s*\S/.test(l) || /\{\{.*\.(?:Values|Chart|Release)\b/.test(l));
      if(line>=0) add("helm","Chart, values or template declarations; rendering unverified",line+1,"chart-declaration");
    }
  }
  const name = `source-${digest(`${source.repo}:${source.commit}:${source.path}`).slice(0,24)}.json`;
  const safe = {schema: "aegis.collected-artifact.v1" as const, name, type, source: {repo: source.repo, commit: source.commit, path: source.path, sha256: digest(source.content), ...(source.sourceKind ? {kind:source.sourceKind} : {}), ...(source.sourceUrl ? {url:source.sourceUrl} : {})}, capturedAt: source.capturedAt, facts, limitations};
  return {...safe, sha256: digest(JSON.stringify(safe))};
}

export function collectEvidence(sources: EvidenceSource[]): CollectedArtifact[] {
  const artifacts = sources.flatMap(source => {const artifact = collectSource(source); return artifact ? [artifact] : [];});
  if (new Set(artifacts.map(a => a.name)).size !== artifacts.length) throw new Error("Duplicate source path and revision.");
  return artifacts.sort((a,b) => a.source.path.localeCompare(b.source.path));
}
