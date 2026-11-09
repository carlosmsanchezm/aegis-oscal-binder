import { chooseStartingPoint, navigateWorkspace } from "./helpers/navigation";
import { expect, test } from "@playwright/test";
import { loadSampleAssessment } from "./sample-assessment";
import { CCM_EXAMPLE } from "../lib/aegis/pipeline-evidence";
import type { PipelineEvidence } from "../lib/aegis/pipeline-evidence";

const selection=(r:PipelineEvidence)=>JSON.stringify([r.pipelineUrl,r.commitSha,r.releaseSha256]);

test("received correction → original assessment → draft → CM-6 → measured retest → separate reviewer decision", async ({ page }) => {
  const commit = "01".repeat(20), hash = "ab".repeat(32);
  const correction: PipelineEvidence = { ...CCM_EXAMPLE, source: "Inbound pipeline event", createdAt: "2026-10-05T12:00:00Z", pipelineId: "99", pipelineUrl: CCM_EXAMPLE.pipelineUrl.replace("2894050908", "99"), commitSha: commit, releaseSha256: hash, artifactJobId: "123", findingCount: 31, reviewItems: undefined, approval: { ...CCM_EXAMPLE.approval, commitSha: commit, releaseSha256: hash, mode: "vendor-test" }, verification: {
    sourcePipelineUrl: CCM_EXAMPLE.pipelineUrl, sourceCommit: CCM_EXAMPLE.commitSha, sourceReleaseSha256: CCM_EXAMPLE.releaseSha256,
    tests: CCM_EXAMPLE.reviewItems![0].scope.verification.map((description, i) => ({ description, artifact: ["configuration.json", "identity-verification.json", "runtime.json"][i], artifactSha256: hash, result: `Measured test ${i+1} passed (test fixture)`, verdict: "pass", date: "2026-10-03" })),
    engineering: { owner: "Test engineer", action: "Test correction", risk: "Vendor test criterion", resources: "Test resources", protection: "Unchanged test protection", milestones: [{ id: "test-1", description: "Test correction and retest", target: "2026-10-03", revised: "", reason: "", status: "Done" }] }
  }, artifacts: [...CCM_EXAMPLE.artifacts!, "identity-verification.json"] };
  await page.route("**/api/pipeline/events", route => route.fulfill({ json: { ok: true, configured: true, webhookPath: "/api/pipeline/events", receivedAt: "2026-10-03T07:00:00Z", evidence: correction, releases: [{ evidence: correction, receivedAt: "2026-10-03T07:00:00Z" }, { evidence: {...CCM_EXAMPLE,source:"Inbound pipeline event"},receivedAt:CCM_EXAMPLE.createdAt }], storage: "local" } }));
  await page.goto("/planning/pipeline");
  await page.getByLabel("Evidence system").selectOption("pipeline");
  await expect(page.getByLabel("Release selection", { exact: true })).toHaveValue(selection(correction));
  await expect(page.getByTestId("release-dashboard")).toContainText("Automated vendor test · no independent review");
  await chooseStartingPoint(page, "Load planning example");
  await expect(page.getByTestId("package-map")).toBeVisible();
  await expect(page.getByRole("button", { name: "New package", exact: true })).toBeVisible();
  await expect(page.getByTestId("workspace-navigation")).toHaveAttribute("data-current-view", "map");
  await navigateWorkspace(page, "release");
  await page.getByLabel("Release selection", { exact: true }).selectOption(selection(CCM_EXAMPLE));
  await page.getByRole("button", { name: "View open security review items" }).click();
  await page.getByRole("button", { name: "Assess review item 1", exact: true }).click();
  await loadSampleAssessment(page);
  await page.getByRole("button", { name: "Prepare draft POA&M" }).click();
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await page.getByRole("button", { name: "Apply received retest", exact: true }).click();
  await expect(page.getByLabel("Responsible owner", { exact: true })).toHaveValue("Test engineer");
  await page.getByRole("button", { name: "Record engineering completion", exact: true }).click();
  await page.getByRole("button", { name: "Open CM-6 in Level 2 →", exact: true }).click();
  await expect(page.getByTestId("level2-focus")).toBeVisible();
  await navigateWorkspace(page, "release");
  await page.locator("[data-testid=internal-plans] button").click();
  await page.getByRole("button", { name: "ISSE", exact: true }).click();
  await expect(page.locator(".rem-test-table")).toContainText("Measured test 2 passed");
  await expect(page.getByRole("button", { name: "Record validation", exact: true })).toBeDisabled();
  await page.locator("summary").filter({ hasText: /^Verification record/ }).click();
  await page.getByLabel("Verification rationale", { exact: true }).fill("Illustrative decision for the scoped vendor tests only.");
  await page.getByLabel("ISSE reviewer", { exact: true }).fill("Example ISSE (synthetic)");
  await page.getByLabel("Verification date", { exact: true }).fill("2026-10-03");
  await page.getByRole("radio", { name: "Demonstrated", exact: true }).check();
  await page.getByRole("button", { name: "Record validation", exact: true }).click();
  await page.getByRole("button", { name: "ISSO", exact: true }).click();
  await page.getByRole("button", { name: "Mark ready for closure review", exact: true }).click();
  await expect(page.getByRole("button", { name: "Record agency closure decision", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Release evidence →", exact: true }).click();
  await page.getByLabel("Release selection", { exact: true }).selectOption(selection(correction));
  await expect(page.locator("[data-testid=internal-plans] button")).toHaveCount(0);
  await page.getByLabel("Release selection", { exact: true }).selectOption(selection(CCM_EXAMPLE));
  await expect(page.locator("[data-testid=internal-plans] button")).toHaveCount(1);
  await page.reload();
  await expect(page.getByLabel("Release selection", { exact: true })).toHaveValue(selection(CCM_EXAMPLE));
  await expect(page.locator("[data-testid=internal-plans] button")).toHaveCount(1);
});
