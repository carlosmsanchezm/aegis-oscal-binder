import { parseEvidenceEvent, type EvidenceEvent } from "../../builder/evidence";
import { digest } from "../collect";
import { sealCollectedArtifact } from "../seal";
import type { CollectedArtifact, EvidenceFact } from "../types";
import type { IngestedScan } from "./ingest";
import { canonicalSha256 } from "./jcs";
import { verifyRecord } from "./scan-record";
import { AWS_DEPLOYMENT_PRODUCER, AWS_IAC_CRITERIA, type DeploymentCriterion } from "./deployment-criteria";
export type AwsDeploymentBinding = {
  repository: string;
  appliedCommit: string;
  fixPaths: Record<DeploymentCriterion, string[]>;
  plantedBranch?: "codex/phase7-cloud-baseline";
};

/** AWS source identity is kept separate from the operator-attested applied revision. */
export function awsDeploymentEvent(scans: IngestedScan[], binding: AwsDeploymentBinding, fullScans:Record<string,string>={}): EvidenceEvent {
  if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(binding.repository) || !/^[a-f0-9]{40}$/.test(binding.appliedCommit))
    throw new Error("Invalid applied repository binding.");
  if (!scans.length || scans.length > 10) throw new Error("A bounded set of live account captures is required.");
  const identities = new Set<string>();
  const artifacts: CollectedArtifact[] = [];
  for (const scan of scans) {
    verifyRecord(scan.record);
    if (scan.record.run.trigger !== "local-profile" && scan.record.run.trigger !== "github-oidc")
      throw new Error("A fixture cannot enter the live deployment collector.");
    const expectedArtifacts = [...scan.record.collector.artifacts].map(a => a.name + ":" + a.sha256).sort();
    if (JSON.stringify(expectedArtifacts) !== JSON.stringify(scan.artifacts.map(a => a.name + ":" + a.sha256).sort()) ||
      JSON.stringify(scan.record.collector.events.map(e => e.id).sort()) !== JSON.stringify(scan.events.map(e => digest(e.rawEvent)).sort()))
      throw new Error("Live scan artifacts or events do not match their envelope.");
    for (const artifact of scan.artifacts) {
      const source = artifact.source;
      if (source.kind !== "aws-account" || source.account !== scan.record.target.account_id || source.partition !== scan.record.target.partition || !scan.record.target.regions.includes(source.region) ||
        sealCollectedArtifact(artifact).sha256 !== artifact.sha256) throw new Error("Live scan source mismatch.");
      const identity = `${source.partition}:${source.account}:${source.region}`;
      if (identities.has(identity)) throw new Error("Duplicate live account/region capture.");
      identities.add(identity);
      const facts: EvidenceFact[] = Object.keys(AWS_IAC_CRITERIA).map((id, i) => {
        const check = scan.record.checks.find(c => c.check_id === id && c.region === source.region);
        const original = artifact.facts.find(f => f.field === id);
        const paths = binding.fixPaths[id as DeploymentCriterion];
        if (!check || !original || original.value !== check.result || !paths?.length) throw new Error("Deployment criterion is missing or mismatched.");
        // This projection is an IaC configuration review. The complete original
        // inventory keeps its catalog-derived KSI fact keys unchanged.
        return {...original, key:"configuration-scan", line: i + 1, fixPaths: [...paths]};
      });
      facts.push({key:"change-control",field:"deployment.scan_record_sha256",value:scan.record.integrity.sha256,
        line:facts.length+1,content:`deployment.scan_record_sha256 = ${scan.record.integrity.sha256}`});
      if(binding.plantedBranch)facts.push({key:"source-inventory",field:"deployment.demo_branch",value:binding.plantedBranch,line:facts.length+1,content:`deployment.demo_branch = ${binding.plantedBranch}`});
      const projectedSource = {...source, path: `aws-account/${source.region}/applied-iac-checks.json`, sha256: canonicalSha256({record: scan.record.integrity.sha256, facts})};
      artifacts.push(sealCollectedArtifact({
        schema: "aegis.collected-artifact.v1", name: `source-${canonicalSha256(projectedSource).slice(0,24)}.json`,
        type: "Operator-linked AWS deployment checks", source: projectedSource, capturedAt: artifact.capturedAt,
        sha256: "0".repeat(64), facts,
        limitations: [
          "Selected IaC checks only. The complete account capture, including errors and manual checks, is retained separately.",
          "Operator-local live AWS capture; the applied IaC revision is an operator attestation, not a hosted deployment measurement.",
          "Source account, partition and region remain AWS identity; no git identity is assigned to the cloud source.",
          "Demo sandbox resources only. No agency evidence processing or authorization is established.",
        ],
      }));
    }
  }
  const observedAt = scans.map(s => s.record.run.finished_utc).sort().at(-1)!;
  const checks: EvidenceEvent["checks"] = Object.keys(AWS_IAC_CRITERIA).map(id => {
    const values = artifacts.map(a => a.facts.find(f => f.field === id)!.value);
    return {id, version: scans[0].record.scanner.version, description: `Live AWS ${id}; every bound account/region must explicitly pass.`,
      requirement: {framework: "AWS deployment checks", reference: id, objective: `Every bound account and region explicitly reports PASS for ${id}.`},
      verdict: values.some(v => v === "fail") ? "fail" : values.every(v => v === "pass") ? "pass" : "unknown",
      artifacts: artifacts.map(a => a.name), validUntil: new Date(Date.parse(observedAt) + 86400_000).toISOString()};
  });
  for(const scan of scans){
    const href=fullScans[scan.record.integrity.sha256];
    if(!href)continue;
    const reference=href.match(/^\/api\/builder\/evidence\/([a-f0-9]{64})\?connection=([a-f0-9-]{36})&artifact=scan-([a-f0-9]{24})\.json$/);
    if(!reference||reference[3]!==scan.record.integrity.sha256.slice(0,24))throw new Error("Invalid full scan reference.");
    const values:Record<string,string|number>={...Object.fromEntries(Object.entries(scan.record.summary).map(([key,value])=>[`inventory.${key}`,value])),"inventory.full_scan_receipt":reference[1],"inventory.connection_id":reference[2],"inventory.scan_record_sha256":scan.record.integrity.sha256,...(binding.plantedBranch?{"deployment.demo_branch":binding.plantedBranch}:{})};
    const facts:EvidenceFact[]=Object.entries(values).map(([field,value],i)=>({key:"source-inventory",field,value,line:i+1,content:`${field} = ${value}`}));
    const source={kind:"aws-account" as const,account:scan.record.target.account_id,partition:scan.record.target.partition,region:scan.record.target.regions[0],path:"aws-account/full-scan-summary.json",sha256:canonicalSha256({record:scan.record.integrity.sha256,href})};
    artifacts.push(sealCollectedArtifact({schema:"aegis.collected-artifact.v1",name:`source-${canonicalSha256(source).slice(0,24)}.json`,type:"AWS account inventory summary",source,capturedAt:scan.record.run.finished_utc,sha256:"0".repeat(64),facts,limitations:["Operator-run collector on the Mac; point-in-time capture, not hosted or continuous scanning.","Inventory only, not a clean-account result or control effectiveness verdict. Planted-gap checks are evaluated separately."]}));
  }
  return parseEvidenceEvent({
    schema: "aegis.evidence-event.v1",
    run: {id: "aws-deployment-" + canonicalSha256({records: scans.map(s => s.record.integrity.sha256).sort(), binding,fullScans}).slice(0,32), producer: AWS_DEPLOYMENT_PRODUCER, observedAt},
    subject: {kind: "code", id: binding.repository, revision: binding.appliedCommit}, checks,
    artifacts: artifacts.map(a => {const bytes = JSON.stringify(a); return {name:a.name, mediaType:"application/json", contentBase64:Buffer.from(bytes).toString("base64"), sha256:digest(bytes)};}),
    limitations: [
      "Operator-local AWS capture linked to an operator-attested applied IaC revision. This is not a GitHub Actions or hosted AWS scan.",
      "Selected planted-gap checks only; complete account observations remain separate and may contain many errors.",
      "Current-head Checkov can establish IaC review readiness. Only later live AWS PASS in every bound account/region can establish deployed remediation.",
      "Human merge, applicability, closure and authorization remain separate decisions.",
    ],
  });
}

