import {test,expect,type Page} from '@playwright/test';
import {navigateWorkspace} from './helpers/navigation';
import {expectMapRoutes} from './helpers/map-routes';

async function load(page:Page,system:'podinfo'|'boutique'){
 await page.goto('/planning');await page.getByRole('radio',{name:/FedRAMP Rev5/}).check();
 if(system==='podinfo'){await page.getByLabel('Evidence system').selectOption('example');await navigateWorkspace(page,"map");} else{await page.getByLabel('Evidence system').selectOption('captured-reference');await page.getByRole('button',{name:'Load captured Online Boutique evidence'}).click();await navigateWorkspace(page,"map");}
}
for(const system of ['podinfo','boutique'] as const){
 test(`${system}: observations retain independent selected-control fans, family inspection and truthful snapshot titles after SSP`,async({page})=>{
  await load(page,system);const control=system==='podinfo'?'CM-6':'AC-6';
  await page.getByRole("checkbox",{name:"Show untouched controls"}).check();await page.locator(`[data-control-id="${control}"]`).click();await expectMapRoutes(page);
  const families=await page.locator('[data-family-box]').evaluateAll(ns=>ns.map(n=>n.getAttribute('data-family-box')!));
  for(const family of families){await page.getByRole('button',{name:`Open ${family} family details`,exact:true}).click();await page.mouse.move(0,0);if(await page.locator('path[data-rel="related"]').count())await expectMapRoutes(page);}
  await navigateWorkspace(page,'export');await page.getByRole('button',{name:'Load sample SSP for this workspace'}).click();await navigateWorkspace(page,'map');
  await page.locator(`[data-control-id="${control}"]`).click();await expectMapRoutes(page);
  const snapshotName=page.locator('.round21-snapshot summary>b>span');
  await expect(snapshotName).toHaveAttribute('title',system==='podinfo' ? /Podinfo/ : /Online Boutique/);
  expect(await snapshotName.evaluate(el=>el.scrollWidth<=el.clientWidth+1 || Boolean(el.getAttribute("title")))).toBe(true);
  const routesInsideCanvas=await page.locator('.pmap-layer').evaluate(layer=>{
   const svg=layer.querySelector<SVGSVGElement>('.pmap-wires')!;
   return Array.from(svg.querySelectorAll<SVGPathElement>('path[data-rel="related"]')).every(path=>{const box=path.getBBox();return box.x>=0&&box.y>=0&&box.x+box.width<=svg.width.baseVal.value&&box.y+box.height<=svg.height.baseVal.value;});
  });expect(routesInsideCanvas).toBe(true);
  const missing=page.getByRole('button',{name:'Missing',exact:true});
  await expect(missing).toHaveAttribute('aria-pressed','true');
  const missingCount=await page.locator('.pmap-pill[data-flag-for]').count();expect(missingCount).toBeGreaterThan(0);
  await expect(page.locator('path[data-rel="missing"]')).toHaveCount(missingCount);
  await missing.click();await expect(page.locator('path[data-rel="missing"]')).toHaveCount(0);
  await expect(page.locator('.pmap-pill[data-flag-for]')).toHaveCount(0);
  await missing.click();await expect(page.locator('path[data-rel="missing"]')).toHaveCount(missingCount);
  for(const family of await page.locator('[data-family-box]').evaluateAll(ns=>ns.map(n=>n.getAttribute('data-family-box')!))){await page.locator(`[data-family-header="${family}"]`).hover();if(await page.locator('path[data-rel="related"]').count())await expectMapRoutes(page);}
 });
 test(`${system}: selected control and map mode survive reload and one cookie deletion clears the workspace`,async({page,context})=>{
  await load(page,system);const control=system==='podinfo'?'CM-6':'AC-6';await page.locator(`[data-control-id="${control}"]`).click();await expect(page.getByTestId('pipeline-control-panel')).toBeVisible();
  await page.getByRole('button',{name:'By family',exact:true}).click();await page.reload();
  await expect(page.locator(`[data-control-id="${control}"]`)).toHaveAttribute('aria-pressed','true');
  await expect(page.getByRole('button',{name:'By family',exact:true})).toHaveAttribute('aria-pressed','true');
  await page.getByRole('button',{name:'Selected control',exact:true}).click();await page.reload();
  await expect(page.getByRole('button',{name:'Selected control',exact:true})).toHaveAttribute('aria-pressed','true');
  await expect(page.getByTestId('pipeline-control-panel')).toBeVisible();
  await page.getByRole('button',{name:`Open ${control} in Level 2 →`}).click();await page.reload();await expect(page.getByTestId('level2-focus')).toBeVisible();
  await context.clearCookies();await page.reload();await expect(page.getByTestId('planning-empty')).toBeVisible();await expect(page.getByLabel('Evidence system')).toHaveValue('');await expect(page.getByRole('radio',{name:/FedRAMP Rev5/})).not.toBeChecked();
  await expect(page.getByText('Failed to fetch',{exact:false})).toHaveCount(0);await page.reload();await expect(page.getByTestId('planning-empty')).toBeVisible();
 });
}
test('an established session read cannot restore deleted cookies and a transient evidence read recovers silently',async({page,context})=>{
 await load(page,'boutique');await navigateWorkspace(page,'connections');
 const established=await page.request.get('/api/package?workspace=sa1-demo');expect(established.headers()['set-cookie']).toBeUndefined();
 let requests=0;await page.route('**/api/builder',async route=>{requests++;if(requests===1)await route.abort('failed');else await route.continue();});
 await page.getByRole('button',{name:'↻ Refresh evidence'}).click();await expect.poll(()=>requests).toBe(2);
 await expect(page.getByRole('button',{name:'Retry connection'})).toHaveCount(0);await expect(page.getByText('Failed to fetch',{exact:false})).toHaveCount(0);
 await page.unroute('**/api/builder');await context.clearCookies();await page.reload();await expect(page.getByTestId('planning-empty')).toBeVisible();
});


test('cookie deletion between the acceptance read and write cannot carry a decision into the new session',async({page,context})=>{
 await load(page,'podinfo');await navigateWorkspace(page,'release');await page.getByRole('button',{name:'Open proposed plan CM-6 · Application UID/GID hardening'}).click();
 await expect(page.getByRole('button',{name:'Accept proposed draft',exact:true})).toBeEnabled();
 let release!:()=>void,started!:()=>void;const pending=new Promise<void>(r=>release=r),seen=new Promise<void>(r=>started=r);
 await page.route('**/api/remediation?*',async route=>{if(route.request().method()!=='GET'){await route.continue();return;}const response=await route.fetch();started();await pending;await route.fulfill({response});});
 await page.getByRole('button',{name:'Accept proposed draft',exact:true}).click();await seen;await context.clearCookies();
 const refused=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/remediation'&&r.request().method()==='PUT');release();const response=await refused;
 expect(response.status()).toBe(409);expect(response.headers()['set-cookie']).toBeUndefined();
 await expect(page.getByTestId('plan-proposal')).toContainText('This browser session changed');
 await page.unroute('**/api/remediation?*');await page.reload();await expect(page.getByTestId('planning-empty')).toBeVisible();
 await page.getByLabel('Evidence system').selectOption('example');await navigateWorkspace(page,"map");await navigateWorkspace(page,'release');await page.getByRole('button',{name:'Open proposed plan CM-6 · Application UID/GID hardening'}).click();
 await expect(page.getByRole('button',{name:'Accept proposed draft',exact:true})).toBeEnabled();
});
