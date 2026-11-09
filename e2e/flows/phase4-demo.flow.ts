import {test,expect} from "@playwright/test";
import {readFileSync} from "node:fs";
import type {EvidenceConnection} from "../../lib/aegis/connected-evidence";
import type {SystemObservationEvidence} from "../../lib/aegis/pipeline-evidence";
import type {PlanProposal} from "../../lib/aegis/plan-proposal";
import type {ReleaseEvidence} from "../../lib/aegis/release-evidence";
const fixture=JSON.parse(readFileSync("e2e/fixtures/release-bundle.json","utf8")) as {connection:EvidenceConnection;records:SystemObservationEvidence[];proposals:PlanProposal[]};
for(const viewport of [{width:1440,height:900},{width:1280,height:800}])test("Phase 4 stopwatch and live map refresh at "+viewport.width,async({page},info)=>{
 await page.setViewportSize(viewport);let green=false,loads=0;
 const {connection,records,proposals}=fixture,startedAt=new Date(Date.now()-10000).toISOString();
 const bundle=():ReleaseEvidence=>({schema:"binder.release-evidence.v1",connectionId:connection.id,repository:records[0].observation.subject.id,releaseId:records[1].pipelineId,releaseSha256:records[1].releaseSha256,commitSha:records[1].commitSha,previousCommitSha:records[0].commitSha,tagOrDeploy:records[1].artifactJobId,collectedAt:new Date(Date.parse(startedAt)+5000).toISOString(),releaseUrl:records[0].observation.subject.id+"/actions/runs/"+records[1].artifactJobId,rangeStatus:"verified",remainingControls:[],items:proposals.map((p,i)=>({poamItemId:p.id,findingId:p.id.split(":").at(-1)!,sourceReleaseId:records[0].pipelineId,controlId:p.controlId,prNumber:i+7,prUrl:records[0].observation.subject.id+"/pull/"+(i+7),mergeSha:String(i+1).repeat(40),ciRunId:"700",ciRunUrl:records[0].observation.subject.id+"/actions/runs/700",retestResult:green?"pass":"remaining",...(green?{retestReceiptId:records[1].releaseSha256}:{})}))});
 await page.route("**/api/pipeline/events",route=>route.fulfill({json:{ok:true,configured:false,evidence:null,releases:[]}}));
 await page.route("**/api/builder",route=>{loads++;return route.fulfill({json:{ok:true,refreshIntervalMs:3000,connections:[{...connection,releaseEvidence:[bundle()],fixProgress:{startedAt,finishedAt:green?bundle().collectedAt:null,total:proposals.length,verified:green?proposals.length:0}}]}});});
 await page.goto("/planning?view=map");await expect(page.getByTestId("fix-stopwatch")).toContainText("Fix time");
 const tile=page.locator('[data-control-id="CM-6"]');await expect(tile).not.toHaveAttribute("data-release-fixed","true");
 await info.attach("SYNTHETIC-phase4-running-"+viewport.width,{body:await page.screenshot(),contentType:"image/png"});
 const navigation=await page.evaluate(()=>performance.getEntriesByType("navigation").length);green=true;
 await expect(tile).toHaveAttribute("data-release-fixed","true");await expect(tile).toHaveCSS("background-color","rgb(227, 247, 238)");
 await expect(page.getByTestId("fix-stopwatch")).toContainText("Review ready");await expect(page.getByRole("timer")).toHaveText("00:05");expect(loads).toBeGreaterThan(1);
 expect(await page.getByRole("timer").evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true);
 expect(await page.evaluate(()=>performance.getEntriesByType("navigation").length)).toBe(navigation);
 await expect(page.getByTestId("fix-stopwatch")).toHaveAttribute("title",/Human closure remains required/);
 await info.attach("SYNTHETIC-phase4-verified-"+viewport.width,{body:await page.screenshot(),contentType:"image/png"});
 await tile.click();await expect(page.getByTestId("release-bundle-strip")).toBeVisible();
 // Choosing another workspace immediately removes the prior connection's stopwatch.
 await page.getByLabel("Evidence system").selectOption("example");await expect(page.getByTestId("fix-stopwatch")).toHaveCount(0);
});
