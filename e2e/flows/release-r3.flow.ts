import {readFileSync} from "node:fs";
import {test,expect,type Page} from "@playwright/test";
import {navigateWorkspace,chooseStartingPoint} from "../helpers/navigation";
import {CCM_EXAMPLE,summaryForSession} from "../../lib/aegis/pipeline-evidence";
async function load(page:Page){
 await page.route("**/api/pipeline/events",route=>route.fulfill({json:{ok:true,configured:false,evidence:null,releases:[]}}));
 await page.goto("/planning");await page.getByLabel("Evidence system").selectOption("example");
 await expect(page.getByTestId("binder-summary")).toBeVisible();await expect(page.getByTestId("artifact-arrival-count")).toContainText("complete");
}
test("release loads its graph, chain, gates, footprint and issues",async({page})=>{await load(page);for(const name of ["Release chain","Evidence in this release","Release gates",/Baseline footprint/,/Issues in this release/])await expect(page.getByRole("heading",{name})).toBeVisible();await expect(page.locator(".release-chain-fold")).toHaveCount(0);await expect(page.getByRole("button",{name:"Open evidence map →"})).toHaveCount(0);});
test("start from a control opens its existing evidence details",async({page})=>{await load(page);await page.getByTestId("binder-summary").getByRole("button",{name:"Evidence for CM-6",exact:true}).first().click();await expect(page.getByLabel("CM-6 evidence details")).toBeVisible();});
test("start from a file returns through a linked control",async({page})=>{await load(page);await page.getByRole("button",{name:"Start from a file"}).click();await expect(page.getByLabel("File",{exact:true})).toBeVisible();await page.locator(".r3-evidence").getByRole("button",{name:/^Evidence for/}).first().click();await expect(page.getByRole("button",{name:"Start from a control"})).toHaveAttribute("aria-pressed","true");});
test("sources menu retains source navigation",async({page})=>{await load(page);await page.locator(".release-sources-menu > summary").click();await expect(page.locator(".release-sources-menu").getByRole("link",{name:/pipeline/i})).toBeVisible();});
test("family footprint opens and closes the existing inspector",async({page})=>{await load(page);await page.locator(".r3-footprint").getByRole("button",{name:/^CM ·/}).click();await expect(page.getByLabel("CM family inspector")).toBeVisible();await page.keyboard.press("Escape");await expect(page.getByLabel("CM family inspector")).toHaveCount(0);});
test("release gate opens the review plan drawer and escape closes it",async({page})=>{await load(page);await page.locator(".release-check-grid").getByRole("button",{name:/Your decision needed/}).first().click();await expect(page.getByTestId("plan-proposal")).toBeVisible();await page.keyboard.press("Escape");await expect(page.getByTestId("plan-proposal")).toHaveCount(0);});
test("triage uses the review drawer and requires an explained outcome",async({page})=>{await load(page);await page.getByRole("button",{name:"Triage",exact:true}).click();await expect(page.getByRole("dialog",{name:"Triage"})).toBeVisible();await expect(page.getByLabel("Triage outcome").locator("option")).toHaveText(["Fix now","Plan it"]);await page.getByLabel("Triage outcome").selectOption("plan-it");await expect(page.getByRole("button",{name:"Record triage"})).toBeDisabled();await page.getByLabel("Triage reason").fill("Synthetic flow verification only");await expect(page.getByRole("button",{name:"Record triage"})).toBeEnabled();await page.getByRole("button",{name:"Record triage"}).click();await expect(page.getByRole("dialog",{name:"Triage"}).getByRole("alert")).toContainText("retained scanner finding");});
test("draft plan reports unavailable evidence without auto accepting",async({page})=>{await load(page);await page.getByRole("button",{name:"Draft plan",exact:true}).first().click();const dialog=page.getByRole("dialog",{name:"Plan of action",exact:true});await expect(dialog).toBeVisible();await dialog.getByRole("button",{name:"Draft plan",exact:true}).click();await expect(dialog.getByRole("alert")).toContainText("retained scanner finding");await expect(dialog.getByRole("button",{name:"Accept proposed draft"})).toHaveCount(0);});
test("suggested source details expand and acceptance needs a reviewer",async({page})=>{await load(page);await page.getByTestId("binder-summary").getByRole("button",{name:"Evidence for CM-6",exact:true}).first().click();const drill=page.getByLabel("CM-6 evidence details");await expect(drill.getByRole("button",{name:"Accept as evidence"}).first()).toBeDisabled();await drill.getByText("More source details",{exact:true}).first().click();await drill.getByRole("button",{name:/Show .* more suggested files/}).click();expect(await drill.getByRole("button",{name:"Accept as evidence"}).count()).toBeGreaterThan(1);});
test("evidence seal expands and retained files remain linked",async({page})=>{await load(page);await page.locator(".release-seal summary").first().click();await expect(page.locator(".release-seal")).toContainText(CCM_EXAMPLE.releaseSha256);await expect(page.locator(".release-chain").getByRole("link").first()).toHaveAttribute("href",/^https:/);});
test("graph selection responds within the unchanged 500 ms budget",async({page})=>{await load(page);const start=await page.evaluate(()=>performance.now());await page.getByRole("button",{name:"Start from a file",exact:true}).click();await expect(page.getByLabel("File",{exact:true})).toBeVisible();const elapsed=await page.evaluate(t=>performance.now()-t,start);expect(elapsed).toBeLessThan(500);});
test("export navigation and no release selection remain functional",async({page})=>{await load(page);await page.getByLabel("Release selection").selectOption("");await expect(page.getByRole("heading",{name:"No release selected"})).toBeVisible();await navigateWorkspace(page,"export");await expect(page.getByRole("button",{name:"Load sample SSP for this workspace"})).toBeVisible();});

test("real Boutique recording preserves run provenance, a measured retest and source bound triage",async({page},info)=>{
 const original=JSON.parse(readFileSync("fixtures/boutique-live/40446239616/event.json","utf8"));
 const retest=JSON.parse(readFileSync("fixtures/boutique-live/40446815397/event.json","utf8"));
 // Test recording stays at its observed time. Production freshness is never renewed.
 await page.clock.setFixedTime(new Date(Date.parse(retest.run.observedAt)+60_000));
 await page.route("**/api/pipeline/events",route=>route.fulfill({json:{ok:true,configured:false,evidence:null,releases:[]}}));
 const created=await page.request.post("/api/builder",{data:{name:"Online Boutique"}});expect(created.status()).toBe(201);const {connection}=await created.json();
 for(const event of [original,retest]){const imported=await page.request.post(`/api/builder/connections/${connection.id}/imports`,{data:event});expect(imported.status()).toBe(201);}
 await page.goto("/planning");await expect(page.getByLabel("Evidence system")).toHaveValue(connection.id);await navigateWorkspace(page,"release");
 await expect(page.locator(".r3-run-link")).toHaveAttribute("href",/actions\/runs\/40446815397$/);
 await expect(page.locator(".r3-issues")).toContainText("Fixed in retest 2");
 await info.attach("real-boutique-retest",{body:await page.screenshot(),contentType:"image/png"});
 await page.locator(".r3-issues").getByRole("button",{name:"Triage",exact:true}).first().click();
 const dialog=page.getByRole("dialog",{name:"Triage",exact:true});await dialog.getByLabel("Triage outcome").selectOption("plan-it");await dialog.getByLabel("Triage reason").fill("Recorded CI verification only. Human review remains required.");
 await dialog.getByRole("button",{name:"Record triage"}).click();await expect(dialog.getByRole("status")).toContainText("Triage recorded by browser:");
 await page.reload();
 const headers={"x-aegis-workspace":"sa1-demo"};
 const key=`binder.plan-proposals.v1:binder-connection:${connection.id}`;
 const saved=await (await page.request.get(`/api/remediation?key=${encodeURIComponent(key)}`,{headers})).json();expect(saved.record.issueTriage).toHaveLength(1);expect(saved.record.issueTriage[0].outcome).toBe("plan-it");expect(saved.record.issueTriage[0].reason).toContain("Human review remains required");
 const standard=await (await page.request.get(`/api/remediation?key=${encodeURIComponent(key)}`)).json();expect(standard.record?.issueTriage??[]).toHaveLength(0);
});
