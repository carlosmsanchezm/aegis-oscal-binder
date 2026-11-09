import {test,expect} from '@playwright/test';
import {navigateWorkspace} from './helpers/navigation';
import {expectMapRoutes} from './helpers/map-routes';
for(const system of ['podinfo','boutique'] as const){
 test(`${system}: direct WIP loading, retained context, bounded families and Level 2 evidence layout`,async({page})=>{
  await page.goto('/planning');
  await expect(page.getByRole('radio',{name:/FedRAMP Rev5/})).not.toBeChecked();
  await page.getByRole('radio',{name:/FedRAMP Rev5/}).check();
  if(system==='podinfo'){await page.getByLabel('Evidence system').selectOption('example');await navigateWorkspace(page,"map");} else {
   await page.getByLabel('Evidence system').selectOption('captured-reference');
   await expect(page.getByRole('button',{name:'Load captured Online Boutique evidence'})).toBeVisible();
   await page.getByRole('button',{name:'Load captured Online Boutique evidence'}).click();
   await navigateWorkspace(page,"map");
  }
  const control=system==='podinfo'?'CM-6':'AC-6',workspace=await page.getByLabel('Evidence system').inputValue();
  await page.locator(`[data-control-id="${control}"]`).click();await expect(page.getByTestId('pipeline-control-panel')).toBeVisible();await expectMapRoutes(page);
  await page.evaluate(()=>document.fonts.ready);
  const heights=await page.locator('.pmap-layer').evaluate(layer=>new Promise<number[]>(resolve=>{
   const samples:number[]=[];function frame(){samples.push(layer.getBoundingClientRect().height);if(samples.length===40)resolve(samples);else requestAnimationFrame(frame);}requestAnimationFrame(frame);
  }));expect(Math.max(...heights)-Math.min(...heights)).toBeLessThanOrEqual(1);
  if(system==='boutique'){
   await page.locator('[data-control-id="AC-6"]').hover();
   await expect(page.locator('.pmap-tip')).toContainText('23 controls in 9 families');
   await expect(page.getByTestId('pipeline-control-panel')).toContainText('23 in 9 families');
  }
  await page.getByRole('button',{name:`Open ${control} in Level 2 →`}).click();
  const related=await page.getByTestId('level2-links').boundingBox(),card=await page.getByTestId('level2-control').boundingBox();
  expect(card!.y).toBeGreaterThanOrEqual(related!.y+related!.height);
  expect(await page.locator('[data-rel="unmapped-evidence"]').count()).toBeGreaterThanOrEqual(await page.locator('[data-item-id]').count());
  await expect(page.getByLabel('Statement evidence mapping')).toContainText('No item-level evidence linked');
  if(system==='boutique'){await expect(page.locator('.round21-focus-bar .round21-snapshot summary')).toContainText('Online Boutique');const board=await page.locator('.round21-focus-board').boundingBox();expect(board!.height).toBeGreaterThan(400);expect(board!.height).toBeLessThan(760);}
  // A server refresh may replace data objects but must not reset map-owned focus.
  await page.clock.install();await page.clock.fastForward(61_000);
  await expect(page.getByTestId('level2-focus')).toBeVisible();
  await page.getByTestId('level2-back').click();
  await navigateWorkspace(page,'connections');
  await page.getByLabel('System name').fill(`${system} context check`);await page.getByRole('button',{name:'Create pipeline connection',exact:true}).click();
  await expect(page.getByRole('status').filter({hasText:'Created connection:'})).toContainText('current workspace is unchanged');
  await expect(page.getByLabel('Evidence system')).toHaveValue(workspace);
  await expect(page.locator('details[open] > summary').filter({hasText:'Set up the first access check'})).toBeVisible();
  await navigateWorkspace(page,'export');await page.getByRole('button',{name:'Load sample SSP for this workspace'}).click();
  await expect(page.getByTestId('workspace-navigation')).toHaveAttribute('data-current-view','export');
  await expect(page.getByLabel('Evidence system')).toHaveValue(workspace);
  const download=page.waitForEvent('download');await page.getByRole('button',{name:'Export OSCAL',exact:true}).click();expect((await download).suggestedFilename()).toMatch(/\.xml$/);
  await expect(page.getByRole('button',{name:'Render Word',exact:true})).toBeDisabled();await expect(page.getByRole('button',{name:'Update baseline',exact:true})).toBeDisabled();
  await navigateWorkspace(page,'release');
  await page.locator('.release-chain-fold > summary').click();
  const chain=await page.locator('.release-chain').boundingBox();const summaries=await page.locator('.release-metrics article').evaluateAll(nodes=>nodes.map(n=>n.getBoundingClientRect().bottom));
  expect(chain!.y).toBeGreaterThanOrEqual(Math.max(...summaries));
 });
}
test('review decisions reset explicitly and cannot migrate from an old tab cache into a new cookie session',async({page,context})=>{
 await page.goto('/planning');await page.getByLabel('Evidence system').selectOption('example');await navigateWorkspace(page,"map");await navigateWorkspace(page,'release');
 const open=()=>page.getByRole('button',{name:'Open proposed plan CM-6 · Application UID/GID hardening'}).click();
 await open();await page.getByRole('button',{name:'Accept proposed draft',exact:true}).click();await expect(page.getByTestId('plan-proposal')).toContainText('Accepted');await page.getByRole('button',{name:'Close proposed plan'}).click();
 await page.getByRole('button',{name:'Reset workspace review decisions',exact:true}).click();await open();await expect(page.getByRole('button',{name:'Accept proposed draft',exact:true})).toBeEnabled();
 await page.getByRole('button',{name:'Accept proposed draft',exact:true}).click();await page.getByRole('button',{name:'Close proposed plan'}).click();
 await context.clearCookies(); // Keep sessionStorage deliberately to reproduce a lingering tab cache.
 await page.reload();await expect(page.getByTestId("planning-empty")).toBeVisible();await expect(page.getByLabel("Evidence system")).toHaveValue("");await page.getByLabel("Evidence system").selectOption("example");await navigateWorkspace(page,"map");await navigateWorkspace(page,"release");await open();await expect(page.getByRole('button',{name:'Accept proposed draft',exact:true})).toBeEnabled();await expect(page.getByTestId('plan-proposal')).toContainText('Proposed until you accept it');
});
