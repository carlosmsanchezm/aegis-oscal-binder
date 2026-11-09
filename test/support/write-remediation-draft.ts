import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { findRepoRoot } from "../../lib/aegis/paths";
import { CCM_EXAMPLE } from "../../lib/aegis/pipeline-evidence";
import { buildPlanOfAction } from "../../lib/aegis/poam";
import { applyRetestPacket, illustrativeScopedAssessment, newPlan } from "../../lib/aegis/remediation";
import { writeRemediationRecord } from "../../lib/aegis/remediation-store";

const id = process.env.SESSION_ID?.trim() ?? "";
const dir = process.env.AEGIS_DATA_DIR?.trim() ?? "";
if (!/^[a-f0-9]{32}$/.test(id) || !dir) {
  process.stderr.write("SESSION_ID and AEGIS_DATA_DIR are required\n");
  process.exit(1);
}
const root = findRepoRoot();
const item = CCM_EXAMPLE.reviewItems?.[0];
if (!item?.scope) {
  process.stderr.write("identity review item is missing\n");
  process.exit(1);
}
const packet = JSON.parse(readFileSync(path.join(root, "public/samples/remediation/podinfo-identity-retest.json"), "utf8")) as unknown;
const plan = applyRetestPacket(
  newPlan(CCM_EXAMPLE, item.description, illustrativeScopedAssessment(item.scope), "DRAFT-identity", "2026-10-03T12:00:00.000Z"),
  packet,
);
await writeRemediationRecord(id, {
  key: `${CCM_EXAMPLE.pipelineUrl}\n${CCM_EXAMPLE.commitSha}`,
  assessment: plan.assessment,
  assessments: { [item.description]: plan.assessment },
  plans: [plan],
});
writeFileSync(path.join(dir, "poam-export.json"), JSON.stringify(buildPlanOfAction(plan, new Date("2026-10-03T18:00:00.000Z"))));
process.stdout.write("ok\n");
