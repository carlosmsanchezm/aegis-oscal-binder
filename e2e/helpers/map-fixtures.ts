import {expect,type Page} from "@playwright/test";
import {generatedMapFixture,type FixtureSize} from "../../test/support/map-fixtures";
import {summaryForSession} from "../../lib/aegis/pipeline-evidence";
import {navigateWorkspace} from "./navigation";
export async function importFixture(page:Page,size:FixtureSize){
 const fixture=generatedMapFixture(5721,size);
 await page.goto("/planning");
 await page.getByRole("radio",{name:/FedRAMP Rev5/}).check();
 await page.getByLabel("OSCAL package").setInputFiles({name:"synthetic-ssp.json",mimeType:"application/json",buffer:Buffer.from(JSON.stringify(fixture.document))});
 await page.getByRole("button",{name:"Upload OSCAL",exact:true}).click();
 await expect(page.getByRole("button",{name:"New package",exact:true})).toBeVisible();
 await page.getByLabel("Evidence system").selectOption("example");
 for(const record of fixture.records){
  await page.locator('.pipeline-import').filter({hasText:'Import CCM summary JSON'}).locator('input[type="file"]').setInputFiles({name:`fixture-${record.pipelineId}.json`,mimeType:"application/json",buffer:Buffer.from(JSON.stringify(summaryForSession(record)))});
  await expect(page.locator(".release-context")).toContainText(`#${record.pipelineId}`);
 }
 const started=Date.now();await navigateWorkspace(page,"map");
 await expect(page.getByTestId("package-map")).toHaveAttribute("data-layout-engine","round21");
 await expect(page.locator(".pmap-control")).toHaveCount(fixture.ids.size);
 return {fixture,renderMs:Date.now()-started};
}
