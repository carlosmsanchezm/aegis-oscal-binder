import {referenceProposals as proposePlans} from "./support/reference-history";
import {CCM_EXAMPLE} from "./support/collected-example";
import assert from "node:assert/strict";
import test from "node:test";
import {collectEvidence, collectSource, digest} from "../lib/collector/collect";
import {collectorEvents} from "../lib/collector/events";
import {readCollectedArtifact} from "../lib/collector/read";
import {factCandidates, collectedFindings} from "../lib/collector/mappings";
import {verifyBundle} from "../lib/server/builder-store";
import {summarizeBuilderBundle} from "../lib/server/builder-observation";
import {parseEvidenceEvent} from "../lib/builder/evidence";
import {connectedReleases} from "../lib/aegis/connected-evidence";
import {moderateControls} from "../lib/aegis/moderate-baseline";
import {proposeArtifactMappings, applyAcceptedArtifactMappings, mappingDecision} from "../lib/aegis/artifact-mapping";
import {applyReleaseRollup} from "../lib/aegis/rollup-package";
import {moderateRollupShell} from "../lib/aegis/rollup-shell";
import {gitlabArtifactUrl,} from "../lib/aegis/pipeline-evidence";
import {recordedEvidenceHref} from "../lib/aegis/recorded-evidence";
const source = {repo:"https://github.com/example/service",commit:"a".repeat(40),capturedAt:"2026-10-08T00:00:00.000Z"};
const allowed = new Set(moderateControls().map(c=>c.id));
const workload = `apiVersion: apps/v1\nkind: Deployment\nspec:\n  template:\n    metadata:\n      annotations:\n        prometheus.io/scrape: 'true'\n    spec:\n      containers:\n      - name: app\n        securityContext:\n          runAsNonRoot: false\n          readOnlyRootFilesystem: true\n          allowPrivilegeEscalation: false\n        resources:\n          limits:\n            memory: 128Mi\n        readinessProbe:\n          httpGet:\n            path: /ready\n`;
function artifact(path:string,content:string){return collectSource({...source,path,content})!;}
function releases(artifacts:ReturnType<typeof collectEvidence>){
 const events=collectorEvents(artifacts);
 return connectedReleases({id:"11111111-1111-4111-8111-111111111111",name:"Unrelated source system",createdAt:source.capturedAt,revokedAt:null,
 history:events.map(({id,rawEvent})=>summarizeBuilderBundle(verifyBundle({schema:"aegis.evidence-bundle.v1",id,connectionId:"11111111-1111-4111-8111-111111111111",receivedAt:source.capturedAt,rawEvent,event:parseEvidenceEvent(JSON.parse(rawEvent)),integrity:"verified",authentication:"browser-owner"})))},"https://binder.test");
}
test("collector extracts contextual workload facts with precise lines and independent source hashes",()=>{
 const a=artifact("deploy/workload.yaml",workload);
 assert.equal(a.type,"Kubernetes workloads"); assert.equal(a.source.sha256,digest(workload));
 assert.equal(a.facts.find(f=>f.key==="non-root")?.line,12);
 assert.equal(a.facts.find(f=>f.key==="non-root")?.outcome,"fail");
 assert.ok(a.facts.some(f=>f.key==="resource-limits")); assert.ok(a.facts.some(f=>f.key==="probe"));
 assert.ok(a.facts.some(f=>f.field.includes("prometheus.io/scrape"))); assert.deepEqual(readCollectedArtifact(a),a);
 const b=artifact("renamed.yaml",workload); assert.deepEqual(factCandidates(a,allowed,"fedramp-rev5").map(c=>c.controlId),factCandidates(b,allowed,"fedramp-rev5").map(c=>c.controlId));
 assert.ok(factCandidates(a,allowed,"fedramp-rev5").every(c=>c.reasons.every(r=>r.includes(a.source.path) && /:\d+/.test(r))));
});
test("collector retains no raw secret values, private keys, environment values or source text",()=>{
 const canary="DO_NOT_RETAIN_PRIVATE_VALUE_8390";
 const a=artifact("secret.yaml",`apiVersion: v1\nkind: Secret\ndata:\n  password: ${canary}\nstringData:\n  token: ${canary}\n`);
 const b=artifact("workflow/.github/actions/build/action.yaml",`runs:\n  using: composite\n  steps:\n    - run: echo ${canary}\n      env:\n        PASSWORD: ${canary}\n`);
 assert.ok(!JSON.stringify([a,b]).includes(canary)); assert.ok(!JSON.stringify(collectorEvents([a,b])).includes(Buffer.from(canary).toString("base64")));
 assert.equal(collectSource({...source,path:"credentials.env",content:`TOKEN=${canary}`}),null);
});
test("Helm templates are not rendered or treated as deployed measurements",()=>{
 const a=artifact("charts/service/templates/deployment.yaml",`kind: Deployment\nmetadata:\n  name: {{ include "app.name" . }}\nspec:\n  securityContext:\n    runAsNonRoot: false\n`);
 assert.ok(a.limitations.some(l=>l.includes("Unrendered"))); assert.ok(a.facts.every(f=>!f.outcome));
});
test("CI, dependency, SBOM, scan, signatures, docs, RBAC and policies map from facts without sample names",()=>{
 const cases=[
  ["Dockerfile","FROM alpine:3.21\nUSER app\n","base-image"],
  [".github/workflows/test.yml",`name: ci\njobs:\n  test:\n    steps:\n      - uses: actions/checkout@${"b".repeat(40)}\n      - run: go test ./...\n      - run: cosign sign image\n`,"pinned-action"],
  ["go.mod","module example/service\nrequire example/library v1.0.0","dependency-manifest"],
  ["bom.json",JSON.stringify({bomFormat:"CycloneDX",components:[{}]}),"sbom"],
  ["scan.json",JSON.stringify({Results:[{Vulnerabilities:[{VulnerabilityID:"CVE-test"}]}]}),"vulnerability-scan"],
  ["sig.json",JSON.stringify({signatures:[{sig:"redacted"}],predicateType:"https://slsa.dev/provenance/v1"}),"signature"],
  ["SECURITY.md","Please report vulnerabilities to the security team.","security-policy"],
  ["README.md","Architecture: microservices communicate through gRPC.","architecture-doc"],
  ["account.yaml","kind: ServiceAccount\nmetadata:\n  name: app","service-account"],
  ["policy.yaml","kind: NetworkPolicy\nspec:\n  policyTypes: [Ingress]","network-policy"],
  ["monitor.yaml","kind: ServiceMonitor\nspec:\n  endpoints: []","monitor-config"],
  ["chart/monitor.yaml","{{ if enabled }}\nkind: ServiceMonitor\n{{ end }}","monitor-config"],
  ["kustomize/kustomization.yaml","resources: [workload.yaml]","kustomize"]
 ];
 for(const [path,content,key] of cases){const a=artifact(path,content);assert.ok(a.facts.some(f=>f.key===key),path);assert.ok(factCandidates(a,allowed,"fedramp-rev5").length,path);}
 assert.equal(artifact("Dockerfile",`FROM --platform=$BUILDPLATFORM alpine:3.21@sha256:${"a".repeat(64)} AS builder`).facts[0].value,`alpine:3.21@sha256:${"a".repeat(64)}`);
 assert.equal(artifact("Dockerfile","FROM https://user:private@example.com/image").facts.length,0);
 assert.equal(artifact("Dockerfile",`FROM alpine:3.21@sha256:${"a".repeat(64)}`).facts.find(f=>f.key==="pinned-base-image")!.field,"FROM.digest");
 assert.equal(artifact("Dockerfile","USER root:1000").facts[0].outcome,"fail");
 assert.equal(artifact("Dockerfile","USER 00:1000").facts[0].key,"root-user");
 assert.equal(artifact("package.json","{}").facts.length,0);
 assert.equal(artifact(".github/workflows/empty.yml","").facts.length,0);
 assert.equal(artifact(".github/workflows/empty.yml","jobs: {}").facts.length,0);
 const config=artifact("config.json",JSON.stringify({Results:[{Misconfigurations:[{ID:"AVD-KSV-0001",Status:"FAIL"}]}]}));
 assert.equal(config.facts.find(f=>f.key==="configuration-scan")!.value,"FAIL");
 assert.equal(config.facts.find(f=>f.key==="configuration-check")!.field,"$.Results[0].Misconfigurations[0].ID");
 assert.equal(artifact("kustomize/kustomization.yaml","").facts.length,0);
 assert.equal(artifact("go.mod","// comment\nrequire example/service v1.0.0").facts[0].line,2);
 assert.equal(artifact("package.json",`{\n \"dependencies\": {\"library\":\"1.0.0\"}\n}`).facts[0].field,"$.dependencies");
 assert.equal(artifact("scan.json",cases[4][1]).facts[0].field,"$.Results");
 assert.equal(artifact("sig.json",JSON.stringify([{critical:{}}])).facts[0].field,"$[0].critical");
});
test("source events share real connection intake and failed facts draft plans without approvals",()=>{
 const [r]=releases([artifact("deploy/workload.yaml",workload)]);
 assert.equal(r.families.length,0); assert.equal(r.approval,null);
 const proposals=proposeArtifactMappings(r,allowed);assert.ok(proposals.length); assert.ok(proposals[0].candidates.every(c=>c.coverageOnly));
 const plans=proposePlans([r]);assert.ok(plans.length);assert.ok(plans.every(p=>p.acceptance==="proposed" && !p.closureConfirmed && !p.readyToClose));
 const initial=applyReleaseRollup(moderateRollupShell(process.cwd()),[r]);assert.ok(plans.every(p=>initial.controls.find(c=>c.id===p.controlId)?.rollupState==="blank"));
 const decision=mappingDecision(r,proposals[0],"accepted",source.capturedAt,[proposals[0].candidates[0].controlId],"Reviewer");
 assert.equal(applyAcceptedArtifactMappings(r,[decision]).families.length,1);
 const approved=applyReleaseRollup(moderateRollupShell(process.cwd()),[applyAcceptedArtifactMappings(r,[decision])]);assert.equal(approved.controls.find(c=>c.id===decision.controls[0])?.rollupState,"recorded");assert.ok(approved.controls.filter(c=>c.rollupState==="recorded").length===1);
 assert.ok(!factCandidates(r.collectedArtifacts![0],new Set(["AC-6"]),"fedramp-20x").length);
});
test("unknown files have no content claims and batches are bounded, reproducible and tamper checked",()=>{
 const artifacts=collectEvidence(Array.from({length:45},(_,i)=>({...source,path:`docs/${i}.md`,content:"No recognized security assertions."})));
 const events=collectorEvents(artifacts); assert.equal(events.length,3);assert.deepEqual(collectorEvents(artifacts),events);
 assert.ok(artifacts.every(a=>a.facts.length===0));assert.equal(collectedFindings(artifacts).length,0);
 const parsed=JSON.parse(events[0].rawEvent);parsed.artifacts[0].sha256="f".repeat(64);
 const rawEvent=JSON.stringify(parsed);assert.throws(()=>verifyBundle({schema:"aegis.evidence-bundle.v1",id:digest(rawEvent),connectionId:"11111111-1111-4111-8111-111111111111",receivedAt:source.capturedAt,rawEvent,event:parseEvidenceEvent(parsed),integrity:"verified",authentication:"browser-owner"}),/digest mismatch/i);
 assert.throws(()=>artifact("../bad.yaml","kind: Deployment"),/relative/);
 assert.throws(()=>collectSource({...source,repo:"https://user:secret@example.com/repo",path:"test.yaml",content:"kind: Pod"}),/credentials/);
});
test("mixed source pins stay separate and changed facts cannot inherit an earlier collected mapping",()=>{
 const a=artifact("deploy/a.yaml",workload),b=collectSource({...source,commit:"b".repeat(40),path:"deploy/b.yaml",content:workload})!;
 const records=releases([a,b]);assert.equal(records.length,2);assert.equal(new Set(records.map(r=>r.commitSha)).size,2);
 const [r]=releases([a]);const p=proposeArtifactMappings(r,allowed)[0];const decision=mappingDecision(r,p,"accepted",source.capturedAt);
 const mutated=structuredClone(r);mutated.collectedArtifacts![0].sha256="f".repeat(64);
 assert.equal(applyAcceptedArtifactMappings(mutated,[decision]).families.length,0);
 assert.throws(()=>collectSource({...source,path:"input.json",content:"{}",sourceUrl:"https://username:private@example.com/release"}),/credentials/);
});
test("safe source intake rejects hidden extra data instead of retaining it in original event bytes",()=>{
 const a=artifact("workload.yaml",workload),original=collectorEvents([a])[0];
 const make=(rawEvent:string)=>({schema:"aegis.evidence-bundle.v1",id:digest(rawEvent),connectionId:"11111111-1111-4111-8111-111111111111",receivedAt:source.capturedAt,rawEvent,event:parseEvidenceEvent(JSON.parse(rawEvent)),integrity:"verified",authentication:"browser-owner"});
 const event=JSON.parse(original.rawEvent);event.privateValue="NEVER_RETAIN_THIS";assert.throws(()=>verifyBundle(make(JSON.stringify(event))),/extra fields/);
 delete event.privateValue;const extra={...a,privateValue:"NEVER_RETAIN_THIS"};const content=JSON.stringify(extra);event.artifacts[0].contentBase64=Buffer.from(content).toString("base64");event.artifacts[0].sha256=digest(content);assert.throws(()=>verifyBundle(make(JSON.stringify(event))),/extra fields/);
});

test("retained source facts work for other repository providers and are not presented as historical pipeline files",()=>{
 const a=collectSource({...source,repo:"https://gitlab.com/independent/service",path:"deployment.yaml",content:workload})!;const [r]=releases([a]);
 assert.match(gitlabArtifactUrl(r,a.name)!,/^\/api\/builder\/evidence\/[a-f0-9]{64}\?connection=/);assert.ok(proposePlans([r]).length);
 const capture=CCM_EXAMPLE.collectedArtifacts!.find(a=>a.source.path==="Dockerfile")!;const url=gitlabArtifactUrl(CCM_EXAMPLE,capture.name)!;assert.match(url,/github.com/);assert.equal(recordedEvidenceHref(url,CCM_EXAMPLE),null);
});
