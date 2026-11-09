import {test,expect,type Page} from "@playwright/test";
import {navigateWorkspace,chooseStartingPoint} from "./helpers/navigation";
import {importFixture} from "./helpers/map-fixtures";

import {loadRef2} from "./helpers/ref2";
for(const workspace of ['reference','boutique','huge'] as const)test(`${workspace} uses count sized families and side panels`,async({page},info)=>{
 test.setTimeout(180000);await page.setViewportSize({width:1920,height:1114});
 if(workspace==='reference')await loadRef2(page);
 else if(workspace==='huge')await importFixture(page,'huge');
 else{await page.goto('/planning?view=connections');await page.getByRole('button',{name:'Load captured Online Boutique evidence',exact:true}).click();await expect(page.getByTestId('binder-summary').getByTestId('artifact-arrival-count')).toContainText('complete');await navigateWorkspace(page,'export');await page.getByRole('button',{name:'Load sample SSP for this workspace',exact:true}).click();await expect(page.getByRole('button',{name:'New package',exact:true})).toBeVisible();await navigateWorkspace(page,'map');}
 const map=page.getByTestId('package-map');await expect(map).toHaveAttribute('data-layout-engine','round21');
 const geometry=await map.locator('[data-family-box]').evaluateAll(nodes=>nodes.map(node=>({id:node.getAttribute('data-family-box')!,x:Number(node.getAttribute('x')),y:Number(node.getAttribute('y')),w:Number(node.getAttribute('width')),h:Number(node.getAttribute('height'))})));
 const members=await map.locator('[data-control-id]').evaluateAll(nodes=>nodes.reduce((counts,node)=>{const id=node.getAttribute('data-family')!;counts[id]=(counts[id]??0)+1;return counts;},{} as Record<string,number>));
 for(const a of geometry)for(const b of geometry){if(members[a.id]>members[b.id]&&members[b.id]<20)expect(a.w).toBeGreaterThan(b.w);if(a!==b)expect(Math.min(a.x+a.w,b.x+b.w)>Math.max(a.x,b.x)&&Math.min(a.y+a.h,b.y+b.h)>Math.max(a.y,b.y)).toBe(false);}
 expect(new Set(geometry.map(family=>family.y)).size).toBeGreaterThan(1);
 if(workspace==='reference'){
  await expect(map.locator('[data-control-id]')).toHaveCount(27);
  await expect(map.locator('.pmap-role')).toHaveCount(6);
  await expect(map.locator('.pmap-evidence:not(.pmap-pipeline-artifact)')).toHaveCount(8);
  expect(geometry.filter(family=>family.y===Math.max(...geometry.map(item=>item.y))).map(family=>family.id)).toEqual(['SC','SI','SR']);
  for(const evidence of await map.locator('.pmap-evidence:not(.pmap-pipeline-artifact)').all())await expect(evidence).toBeInViewport({ratio:1});
 }
 await page.mouse.move(0,0);await page.screenshot({animations:'disabled',path:info.outputPath(`${workspace}-01-map.png`)});
 await map.locator('[data-family-header="CM"] .pmap-family-open').click();await expect(page.getByTestId('map-family-panel')).toBeVisible();await map.locator('[data-family-header="CM"]').scrollIntoViewIfNeeded();await expect(map.locator('[data-family-header="CM"]')).toBeInViewport({ratio:1});await page.mouse.move(0,0);await page.screenshot({animations:'disabled',path:info.outputPath(`${workspace}-02-family-click.png`)});await page.keyboard.press('Escape');
 await map.locator('[data-control-id="CM-6"]').click();await expect(page.getByTestId('pipeline-control-panel')).toBeVisible();await page.mouse.move(0,0);await page.screenshot({animations:'disabled',path:info.outputPath(`${workspace}-03-control-click.png`)});
 const role=map.locator('.pmap-role').filter({hasText:/System Admin/});const selectedRole=await role.count()?role.first():map.locator('.pmap-role').first();
 await selectedRole.click();await expect(page.getByTestId('map-node-panel')).toHaveAttribute('data-kind','role');await expect(map.locator('[data-map-card],path[data-rel="related"],.pmap-control[aria-pressed="true"]')).toHaveCount(0);await expect(page.getByTestId('map-node-panel')).toContainText('control');await page.mouse.move(0,0);await page.screenshot({animations:'disabled',path:info.outputPath(`${workspace}-04-role-click.png`)});
 await page.getByRole('button',{name:'Open role in Level 2 →',exact:true}).click();await expect(page.getByTestId('map-role-focus')).toBeVisible();await page.keyboard.press('Escape');await expect(page.getByTestId('map-node-panel')).toBeVisible();await expect(map.locator('.pmap-role[aria-expanded="true"]')).toHaveCount(1);await page.keyboard.press('Escape');await expect(page.getByTestId('map-node-panel')).toHaveCount(0);
 const evidence=map.locator('[data-evidence-id="EV-CM2-01"]');const selectedEvidence=await evidence.count()?evidence.first():map.locator('.pmap-evidence:not(.pmap-pipeline-artifact)').first();await selectedEvidence.click();await expect(page.getByTestId('map-node-panel')).toHaveAttribute('data-kind','evidence');await expect(map.locator('[data-map-card]')).toHaveCount(0);await selectedEvidence.evaluate(node=>node.scrollIntoView({block:'center',inline:'nearest'}));await expect(selectedEvidence).toBeInViewport({ratio:1});await page.mouse.move(0,0);await page.screenshot({animations:'disabled',path:info.outputPath(`${workspace}-05-evidence-click.png`)});
 await page.getByRole('button',{name:'Open evidence in Level 2 →',exact:true}).click();await expect(page.getByTestId('evidence-focus')).toBeVisible();await page.keyboard.press('Escape');await expect(page.getByTestId('map-node-panel')).toBeVisible();await expect(map.locator('.pmap-evidence[aria-expanded="true"]')).toHaveCount(1);
});
