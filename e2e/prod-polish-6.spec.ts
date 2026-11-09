import {test,expect,type Page} from '@playwright/test';
import {navigateWorkspace} from './helpers/navigation';
async function load(page:Page,system:string){await page.goto('/planning');await page.getByRole('radio',{name:/FedRAMP Rev5/}).check();if(system==='podinfo'){await page.getByLabel('Evidence system').selectOption('example');await navigateWorkspace(page,"map");} else{await page.getByLabel('Evidence system').selectOption('captured-reference');await page.getByRole('button',{name:'Load captured Online Boutique evidence'}).click();await navigateWorkspace(page,"map");}}
for(const width of [1280,1366,1440])test(`true ${width} viewport: ordered chrome, single-line coverage and unclipped legend before and after SSP`,async({page},info)=>{
 const height=width===1366?768:width===1440?900:800;await page.setViewportSize({width,height});
 expect(await page.evaluate(()=>({width:innerWidth,height:innerHeight,scale:visualViewport?.scale,dpr:devicePixelRatio}))).toEqual({width,height,scale:1,dpr:1});
 for(const system of ['podinfo','boutique']){
  await load(page,system);await page.locator(`[data-control-id="${system==='podinfo'?'CM-6':'AC-6'}"]`).click();
  await expect(page.getByTestId("pipeline-control-panel")).toBeVisible();
  for(const sample of [false,true]){
   if(sample){await navigateWorkspace(page,'export');await page.getByRole('button',{name:'Load sample SSP for this workspace'}).click();await navigateWorkspace(page,'map');}
   await expect(page.getByTestId("pipeline-control-panel")).toBeVisible();await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
   await page.screenshot({path:info.outputPath(`${system}-${sample?'ssp':'recorded'}.png`)});
   const title=await page.getByRole('heading',{name:'Package map',exact:true}).boundingBox(),controls=await page.locator('.pmap-toggles').boundingBox();expect(controls!.y).toBeGreaterThanOrEqual(title!.y+title!.height);
   const metrics=await page.evaluate(()=>{
    const oneLine=(e:Element)=>{const r=document.createRange();r.selectNodeContents(e);return new Set([...r.getClientRects()].map(b=>Math.round(b.top))).size;};
    const summary=document.querySelector('.round21-summary')!,legend=document.querySelector('[aria-label="Map legend"]')!,stage=document.querySelector('[data-testid="map-stage"]')!,pin=document.querySelector('.chrome-pin')!;
    return {coverageLines:[...summary.querySelectorAll(':scope>span')].map(oneLine),legendOverflow:legend.scrollWidth-legend.clientWidth,stageOverflow:stage.scrollHeight-stage.clientHeight,pinHeight:pin.getBoundingClientRect().height,legendBoxes:[...legend.children].map(e=>e.getBoundingClientRect().toJSON()),viewport:innerWidth};
   });await info.attach(`${system}-${sample?"ssp":"recorded"}-geometry`,{body:Buffer.from(JSON.stringify(metrics,null,2)),contentType:"application/json"});expect(metrics.coverageLines.every(n=>n<=1)).toBe(true);expect(metrics.legendOverflow).toBeLessThanOrEqual(1);expect(metrics.stageOverflow).toBeGreaterThanOrEqual(0);expect(await page.locator(".pmap-stage").evaluate(node=>["auto","scroll"].includes(getComputedStyle(node).overflowY))).toBe(true);expect(metrics.pinHeight).toBeLessThan(40);for(const b of metrics.legendBoxes){expect(b.right).toBeLessThanOrEqual(width);expect(b.left).toBeGreaterThanOrEqual(0);}
  }
  await page.context().clearCookies();await page.evaluate(()=>{localStorage.clear();sessionStorage.clear();});
 }
});
test('CM-6 primary plan identity stays the original finding before and after acceptance across both snapshots',async({page})=>{
 await load(page,'podinfo');await page.locator('[data-control-id="CM-6"]').click();
 const pinned=page.locator('.control-plan-pinned');
 for(const accepted of [false,true]){
  for(const snapshot of ['2894050908','2908682168']){await page.locator('.round21-snapshot>summary').click();await page.getByRole('option').filter({hasText:'#'+snapshot}).click();await expect(pinned).toContainText('Application UID/GID hardening');await expect(pinned).toContainText(accepted?'Accepted':'Closure proposed');await expect(pinned).not.toContainText('KSV-0125');}
  if(!accepted){await pinned.getByRole('button',{name:'Open plan of action',exact:true}).click();await page.getByRole('button',{name:'Accept proposed draft',exact:true}).click();await page.getByRole('button',{name:'Close proposed plan'}).click();}
 }
 await page.reload();await expect(pinned).toContainText('Application UID/GID hardening');await expect(pinned).toContainText('Accepted');
});
test('Package workspace follows the active planning context and preserves its SSP on reload',async({page})=>{
 await load(page,'podinfo');await page.goto('/workspace');await expect(page.getByLabel('Evidence system')).toHaveValue('example');await expect(page.getByTestId('planning-empty')).toHaveCount(0);
 await navigateWorkspace(page,'export');await page.getByRole('button',{name:'Load sample SSP for this workspace'}).click();await page.goto('/workspace');await expect(page.getByRole('button',{name:'New package',exact:true})).toBeVisible();await expect(page.getByTestId('planning-empty')).toHaveCount(0);await page.reload();await expect(page.getByRole('button',{name:'New package',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'New package',exact:true}).click();await expect(page.getByRole('button',{name:'Upload OSCAL',exact:true})).toBeVisible();await expect(page.getByLabel('Evidence system')).toHaveValue('example');
 // A classic package must remain isolated from the active planning alias.
 const selected=await page.request.post('/api/catalogs/select',{data:{catalog:'fedramp-rev5'}});expect(selected.ok()).toBe(true);const classic=await page.request.post('/api/fixtures/load',{data:{fixture:'gold'}});expect(classic.ok()).toBe(true);await page.goto('/workspace?editor=classic');await expect(page.getByLabel('Evidence system')).toHaveCount(0);await expect(page.getByRole('button',{name:'New package',exact:true})).toBeVisible();await page.goto('/workspace?workspace=planning');await expect(page.getByLabel('Evidence system')).toHaveValue('example');await expect(page.getByRole('button',{name:'New package',exact:true})).toHaveCount(0);await expect(page.getByRole('button',{name:'SSP evidence',exact:true})).toBeEnabled();
});

test('a navigation action persists before an immediate document reload',async({page})=>{
 let release!:()=>void,seen!:()=>void;const gate=new Promise<void>(r=>release=r),requested=new Promise<void>(r=>seen=r);await page.route('**/api/demo/sa1/package',async route=>{seen();await gate;await route.continue();});
 await page.goto('/planning');await requested;await expect(page.getByRole('button',{name:'More',exact:true})).toBeDisabled();await expect(page.getByTestId('workspace-navigation').locator('[data-view="export"]')).toBeDisabled();release();await expect(page.getByRole('button',{name:'More',exact:true})).toBeEnabled();await expect(page.getByTestId('workspace-navigation').locator('[data-view="export"]')).toBeEnabled();
 await page.evaluate(()=>{(document.querySelector('[data-view="export"]') as HTMLButtonElement).click();location.reload();});
 await expect(page.getByTestId('workspace-navigation')).toHaveAttribute('data-current-view','export');await expect(page.getByTestId('export-empty')).toBeVisible();
});
