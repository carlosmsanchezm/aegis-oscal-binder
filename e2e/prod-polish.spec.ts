import {referenceAuthorizationPlan,referencePlanCount} from "./helpers/collector-reference";
import {test,expect,type Page} from '@playwright/test';
import {navigateWorkspace} from './helpers/navigation';
import {expectMapRoutes} from './helpers/map-routes';
async function load(page:Page,system:'podinfo'|'boutique'){
 await page.goto('/planning');await page.getByRole('radio',{name:/FedRAMP Rev5/}).check();
 if(system==='podinfo'){await page.getByLabel('Evidence system').selectOption('example');await navigateWorkspace(page,"map");} else{await page.getByLabel('Evidence system').selectOption('captured-reference');await page.getByRole('button',{name:'Load captured Online Boutique evidence'}).click();await navigateWorkspace(page,"map");}
}
for(const system of ['podinfo','boutique'] as const)test(`${system}: all map routing modes avoid tiles, Level 2 is compact, and modal Escape retains selection`,async({page})=>{
 await load(page,system);const control=system==='podinfo'?'CM-6':'AC-6';
 await page.getByRole("checkbox",{name:"Show untouched controls"}).check();await page.locator(`[data-control-id="${control}"]`).click();await expectMapRoutes(page);
 for(const family of ['AC','AU','CM','SA','SC']){
  await page.getByRole('button',{name:`Open ${family} family details`,exact:true}).click();
  await page.mouse.move(0,0);await expectMapRoutes(page);
 }
 await page.locator(`[data-control-id="${control}"]`).click();await page.getByRole('button',{name:`Open ${control} in Level 2 →`}).click();
 const links=await page.getByTestId('level2-links').boundingBox(),card=await page.getByTestId('level2-control').boundingBox();
 expect(card!.y).toBeGreaterThanOrEqual(links!.y+links!.height);
 await expect(page.getByTestId('selected-statement-detail')).toContainText('Retained evidence');
 const detail=await page.getByTestId('selected-statement-detail').boundingBox(),artifact=await page.locator('[data-statement-evidence]').last().boundingBox();expect(detail!.y).toBeGreaterThanOrEqual(artifact!.y+artifact!.height);
 if(system==='boutique')await expect(page.getByTestId('level2-assessment-objectives')).toContainText('the principle of least privilege is employed');
 await expect(page.locator('.round21-candidate-artifact').first()).toBeVisible();
 await expect(page.getByLabel('Statement evidence mapping')).toContainText('statement mappings need review');
 const open=page.getByTestId('pipeline-control-panel').getByRole('button',{name:'Open plan of action',exact:true}).last();await open.click();
 await expect(page.getByTestId('plan-proposal')).toContainText(system==='podinfo'?'Closure proposed':'Proposed · not accepted');await page.keyboard.press('Escape');
 await expect(page.getByTestId('plan-proposal')).toHaveCount(0);await expect(page.getByTestId('level2-focus')).toBeVisible();
 await page.getByTestId('level2-back').click();await expect(page.locator(`[data-control-id="${control}"]`)).toHaveAttribute('aria-pressed','true');
 await navigateWorkspace(page,'export');await page.getByRole('button',{name:'Load sample SSP for this workspace'}).click();
 await navigateWorkspace(page,'map');await page.locator(`[data-control-id="${control}"]`).click();await expectMapRoutes(page);
 const missing=page.getByRole('button',{name:'Missing',exact:true});await expect(missing).toHaveAttribute('aria-pressed','true');
 const missingCount=await page.locator('.pmap-pill[data-flag-for]').count();expect(missingCount).toBeGreaterThan(0);
 await expect(page.locator('path[data-rel="missing"]')).toHaveCount(missingCount);
 await missing.click();await expect(page.locator('path[data-rel="missing"]')).toHaveCount(0);await expect(page.locator('.pmap-pill[data-flag-for]')).toHaveCount(0);
 await missing.click();await expect(page.locator('path[data-rel="missing"]')).toHaveCount(missingCount);
 for(const family of ['AC','CM','SC']){const tile=await page.locator(`[data-family-box="${family}"]`).boundingBox();await page.mouse.move(tile!.x+1,tile!.y+tile!.height-4);await expectMapRoutes(page);}
 for(const width of [1440,1280]){await page.setViewportSize({width,height:800});await expectMapRoutes(page);}
});
test('Boutique accepted plan status is workspace-wide while retests remain explicitly per snapshot',async({page})=>{
 await load(page,'boutique');await navigateWorkspace(page,'release');await page.getByRole('button',{name:referenceAuthorizationPlan,exact:true}).click();
 await page.getByRole('button',{name:'Accept proposed draft',exact:true}).click();await expect(page.getByTestId('plan-proposal')).toContainText('Accepted · retest expired');
 await expect(page.getByTestId('plan-proposal')).toContainText('02:54:20.862 UTC');await page.getByRole('button',{name:'Close proposed plan'}).click();
 await navigateWorkspace(page,'map');await page.locator('[data-control-id="AC-6"]').click();
 for(const id of ['bf083e020e937ee482a3f70863bc6cc3','7c78c4bb75b2749aecd63d09c90c886e']){
  await page.locator('.round21-snapshot>summary').click();await page.getByRole('option').filter({hasText:'#'+id}).click();
  await expect(page.getByTestId('proposed-plan-summary')).toContainText('Accepted · retest expired');
  await expect(page.getByTestId('pipeline-control-panel')).toContainText('in this snapshot');
 }
 await navigateWorkspace(page,'connections');await expect(page.getByLabel('System name')).toBeVisible();
 await expect(page.getByRole('button',{name:'Create pipeline connection',exact:true})).toBeVisible();
 await expect(page.getByLabel('Retained observation history')).toContainText('02:54:20.612 UTC');await expect(page.getByLabel('Retained observation history')).toContainText('02:54:20.862 UTC');
});
test('a cleared-cookie session and temporary connection failure have quiet actionable recovery',async({page,context})=>{
 await load(page,'boutique');await navigateWorkspace(page,'connections');
 await page.route('**/api/builder',r=>r.abort('failed'));await page.getByRole('button',{name:'↻ Refresh evidence'}).click();
 await expect(page.getByRole('status').filter({hasText:'Connection paused'})).toBeVisible();await expect(page.getByText('Failed to fetch',{exact:false})).toHaveCount(0);
 await page.unroute('**/api/builder');await page.getByRole('button',{name:'Retry connection'}).click();await expect(page.getByRole('button',{name:'Retry connection'})).toHaveCount(0);
 await context.clearCookies();await page.getByRole('button',{name:'↻ Refresh evidence'}).click();
 await expect(page.getByRole('button',{name:'Reload workspace',exact:true})).toBeVisible();await page.getByRole('button',{name:'Reload workspace',exact:true}).click();
 await expect(page.getByLabel('Evidence system')).toHaveValue('');await expect(page.getByTestId('planning-empty')).toBeVisible();await navigateWorkspace(page,'connections');await expect(page.getByRole('button',{name:'Load captured Online Boutique evidence'})).toBeVisible();
});
test('an older refresh cannot clear a newly chosen Boutique workspace or its map selection',async({page})=>{
 await load(page,'boutique');const boutique=await page.getByLabel('Evidence system').inputValue();await navigateWorkspace(page,'connections');
 await page.getByLabel('System name').fill('Refresh race');await page.getByRole('button',{name:'Create pipeline connection',exact:true}).click();await page.getByRole('button',{name:'Switch to Refresh race →'}).click();
 let release!:()=>void,started!:()=>void;const pending=new Promise<void>(resolve=>release=resolve),seen=new Promise<void>(resolve=>started=resolve);
 await page.route('**/api/builder',async route=>{started();await pending;await route.fulfill({json:{ok:true,connections:[]}});});
 await page.getByRole('button',{name:'↻ Refresh evidence'}).click();await seen;
 await page.getByLabel('Evidence system').selectOption(boutique);await navigateWorkspace(page,'map');await page.locator('[data-control-id="AC-6"]').click();
 const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/builder');release();await response;
 await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
 await expect(page.getByLabel('Evidence system')).toHaveValue(boutique);await expect(page.getByTestId('pipeline-control-panel')).toBeVisible();await expect(page.locator('[data-control-id="AC-6"]')).toHaveAttribute('aria-pressed','true');
});
