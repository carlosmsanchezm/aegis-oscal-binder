import {test,expect} from "@playwright/test";
import {readFileSync} from "node:fs";
const plans=JSON.parse(readFileSync("e2e/fixtures/pr-loop-plans.json","utf8")) as {id:string;sourceReleaseId:string}[];
// Synthetic read-side projections only. Provider/collector trust is exercised in PR-loop API/unit tests.
for(const viewport of [{width:1440,height:900},{width:1280,height:800}])test(`POA&M PR link and CI chip preserve the existing drawer at ${viewport.width}`,async({page},info)=>{
  await page.setViewportSize(viewport);
  let state:"pending"|"success"|"failure"="pending";
  await page.route("**/api/pipeline/events",route=>route.fulfill({json:{ok:true,configured:false,evidence:null,releases:[]}}));
  await page.route("**/api/remediation?*",route=>route.fulfill({json:{ok:true,sessionScope:"unit-browser-projection",record:{key:"browser-projection",assessment:null,assessments:{},plans:[],proposals:[],issueDrafts:plans.map(p=>({...p,pullRequest:{schema:"binder.pull-request-link.v1",connectionId:"synthetic",installationId:42,poamItemId:p.id,findingId:p.id.split(":").at(-1),sourceReleaseId:p.sourceReleaseId,owner:"example",repo:"service",prNumber:7,prUrl:"https://github.com/example/service/pull/7",headSha:"a".repeat(40),baseSha:"b".repeat(40),state:"open",ciStatus:{sha:"a".repeat(40),state,checks:1,checkedAt:new Date().toISOString()},createdBy:"agent:synthetic-id",createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()}}))}}}));
  for(const current of ["pending","success","failure"] as const){
    state=current;
    await page.goto("/planning");await page.getByLabel("Evidence system").selectOption("example");
    await expect(page.getByTestId("binder-summary")).toBeVisible();
    await page.locator(".release-check-grid").getByRole("button",{name:/Your decision needed/}).first().click();
    const drawer=page.getByTestId("plan-proposal");await expect(drawer).toBeVisible();
    await expect(drawer.getByRole("link",{name:"PR #7"})).toHaveAttribute("href","https://github.com/example/service/pull/7");
    await expect(drawer.getByLabel(`CI ${state}`)).toHaveText(`CI ${state}`);
    await expect(drawer.getByText("A person confirms closure")).toBeVisible();
    await info.attach(`pr-chip-${state}-${viewport.width}`,{body:await page.screenshot(),contentType:"image/png"});
    await page.keyboard.press("Escape");await expect(drawer).toHaveCount(0);
  }
});
