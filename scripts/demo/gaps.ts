/** Synthetic planting configuration, never an alternate evidence format. */
export const DEMO_GAPS = [
  {id:"DEMO-CODE-01", path:"src/recommendationservice/recommendation_server.py", key:"sast-scan", control:"AC-3", resource:"demo:auth", fix:"Require an authenticated principal before returning a demo record."},
  {id:"DEMO-CODE-02", path:"src/emailservice/email_server.py", key:"secrets-scan", control:"IA-5", resource:"demo:config", fix:"Remove the clearly fake embedded credential and require runtime configuration."},
  {id:"DEMO-CI-01", path:".github/workflows/aegis-synthetic-demo.yml", key:"sast-scan", control:"CM-3", resource:"demo:ci", fix:"Pin the action digest and restrict workflow permissions to contents read."},
  {id:"DEMO-IAC-01", path:"infra/aegis-demo/modules/gaps/bucket.tf", key:"configuration-scan", control:"CM-6", resource:"demo:s3-versioning", fix:"Enable bucket versioning and retain all public-access guardrails."},
  {id:"DEMO-IAC-02", path:"infra/aegis-demo/modules/gaps/network.tf", key:"configuration-scan", control:"SC-7", resource:"demo:ssh-ingress", fix:"Remove world-open SSH; the synthetic VPC has no workloads."},
] as const;
