import {test,expect,type Page} from '@playwright/test';
import {navigateWorkspace} from './helpers/navigation';
async function openControl(page:Page,system:'podinfo'|'boutique'){
 await page.goto('/planning');await page.getByRole('radio',{name:/FedRAMP Rev5/}).check();
 if(system==='podinfo'){await page.getByLabel('Evidence system').selectOption('example');await navigateWorkspace(page,"map");} else{await page.getByLabel('Evidence system').selectOption('captured-reference');await page.getByRole('button',{name:'Load captured Online Boutique evidence'}).click();await navigateWorkspace(page,"map");}
 const control=system==='podinfo'?'CM-6':'AC-6';await page.locator(`[data-control-id="${control}"]`).click();await page.getByRole('button',{name:`Open ${control} in Level 2 →`}).click();return control;
}
for(const system of ['podinfo','boutique'] as const)test(`${system}: retained statement review stays visible alongside SSP links after load and reload`,async({page},info)=>{
 const control=await openControl(page,system),statement=system==='podinfo'?'cm-6_smt.a':'ac-6_smt';
 const reviewAction=page.getByRole('button',{name:system==='podinfo'?`Review mapping from configuration.json to ${statement}`:/Review mapping from/}).first();await reviewAction.click();
 const dialog=page.getByTestId('statement-mapping-review');await dialog.getByLabel('Reviewer',{exact:true}).fill('SSP coexistence reviewer');await dialog.getByLabel('Review rationale').fill('Reviewed this retained artifact for the selected statement. Package links must coexist with this source-bound decision.');await dialog.getByRole('button',{name:'Mark mapping reviewed'}).click();await expect(dialog).toHaveCount(0);
 const readReviews=async()=>(await (await page.request.get('/api/statement-mappings',{headers:{'x-aegis-workspace':'sa1-demo'}})).json()).reviews;
 const saved=await readReviews();expect(saved).toHaveLength(1);const review=saved[0];expect(review).toMatchObject({controlId:control,statementId:statement,reviewer:'SSP coexistence reviewer'});
 const row=page.locator(`[data-statement-evidence="${statement}"]`),artifact=row.locator(`[data-statement-artifact="${review.evidenceId}"]`);
 await expect(artifact).toContainText('Mapping reviewed · SSP coexistence reviewer');await expect(artifact).toHaveAttribute('data-mapping-state','reviewed');
 await navigateWorkspace(page,'export');await page.getByRole('button',{name:'Load sample SSP for this workspace'}).click();await navigateWorkspace(page,'map');await expect(page.getByTestId('level2-focus')).toBeVisible();
 for(const reload of [false,true]){
  if(reload)await page.reload();await expect(page.getByTestId('level2-focus')).toBeVisible();expect(await readReviews()).toEqual(saved);
  await page.locator(`[data-item-id="${statement}"]`).click();await expect(page.getByTestId('selected-statement-detail')).toContainText(review.basis);await expect(artifact).toBeVisible();await expect(artifact).toContainText('Mapping reviewed · SSP coexistence reviewer');await expect(artifact).toHaveAttribute('data-mapping-state','reviewed');
  await expect(page.locator(`path[data-rel="item-evidence"][data-to="evidence-${statement}-${review.evidenceId}"]`)).toHaveCount(1);
  if(system==='podinfo'){await expect(row.getByRole('button',{name:'Baseline manifest ↗'})).toBeVisible();await expect(row).toContainText('SSP evidence');await expect(row).toContainText('Retained observation');const unreviewed=page.locator('[data-statement-evidence="cm-6_smt.b"]').locator(`[data-statement-artifact="${review.evidenceId}"]`);await expect(unreviewed).toHaveAttribute('data-mapping-state','unreviewed');}
 }
 if(system==='podinfo'){
  await page.locator('.round21-snapshot>summary').click();await page.getByRole('option').filter({hasText:'#2908682168'}).click();await expect(row).toContainText('Retained observation · #2908682168');await expect(row.locator('[data-evidence-origin="observation"][data-mapping-state="reviewed"]')).toHaveCount(0);expect(await readReviews()).toEqual(saved);
  await page.locator('.round21-snapshot>summary').click();await page.getByRole('option').filter({hasText:'#2894050908'}).click();await expect(artifact).toHaveAttribute('data-mapping-state','reviewed');await expect(artifact).toContainText('Mapping reviewed · SSP coexistence reviewer');
 }
 await page.screenshot({path:info.outputPath(`${system}-ssp-reviewed.png`)});await info.attach('unchanged-stored-review',{body:JSON.stringify(saved,null,2),contentType:'application/json'});
 await artifact.getByRole('button',{name:'Reopen mapping',exact:true}).click();await expect(artifact).toHaveAttribute('data-mapping-state','unreviewed');await page.reload();await expect(artifact).toHaveAttribute('data-mapping-state','unreviewed');expect(await readReviews()).toEqual([]);
 if(system==='podinfo')await expect(row.getByRole('button',{name:'Baseline manifest ↗'})).toBeVisible();await navigateWorkspace(page,'export');await expect(page.getByRole('button',{name:'Export OSCAL',exact:true})).toBeEnabled();
});

test('recorded milestone target stays intact while its hint follows filled, cleared and saved edits',async({page},info)=>{
 await page.goto('/planning');await page.getByRole('radio',{name:/FedRAMP Rev5/}).check();await page.getByLabel('Evidence system').selectOption('example');await navigateWorkspace(page,"map");await navigateWorkspace(page,'release');await page.getByRole('button',{name:'Open proposed plan CM-6 · Application UID/GID hardening',exact:true}).click();
 const dialog=page.getByTestId('plan-proposal'),target=dialog.getByLabel('Milestone target',{exact:true}),field=dialog.locator('label.rem-field').filter({has:page.getByLabel('Milestone target',{exact:true})});
 await expect(target).toHaveValue('2026-10-03');await expect(field).toContainText('Review or change this target date.');await expect(field).not.toContainText('Blank until set.');
 await target.fill('');await expect(target).toHaveValue('');await expect(field).toContainText('No target date set.');
 await target.fill('2026-10-20');await expect(target).toHaveValue('2026-10-20');await expect(field).toContainText('Review or change this target date.');await dialog.getByRole('button',{name:'Accept proposed draft',exact:true}).click();await expect(dialog.getByRole('button',{name:'Download OSCAL plan of action'})).toBeEnabled();await expect(dialog.getByRole('button',{name:'Save edits',exact:true})).toHaveCount(0);await dialog.getByRole('button',{name:'Close proposed plan'}).click();await page.reload();await page.getByRole('button',{name:'Open proposed plan CM-6 · Application UID/GID hardening',exact:true}).click();await expect(target).toHaveValue('2026-10-20');await expect(field).toContainText('Review or change this target date.');
 await dialog.getByRole('button',{name:'Edit plan',exact:true}).click();await target.fill('');await dialog.getByRole('button',{name:'Save edits',exact:true}).click();await expect(dialog.getByRole('button',{name:'Save edits',exact:true})).toBeEnabled();await dialog.getByRole('button',{name:'Close proposed plan'}).click();await page.reload();await page.getByRole('button',{name:'Open proposed plan CM-6 · Application UID/GID hardening',exact:true}).click();await expect(target).toHaveValue('');await expect(field).toContainText('No target date set.');await info.attach('empty-saved-milestone',{body:await page.screenshot(),contentType:'image/png'});
});

test('plan entry points wait for saved decisions before opening a drawer',async({page})=>{
 await page.goto('/planning');await page.getByRole('radio',{name:/FedRAMP Rev5/}).check();await page.getByLabel('Evidence system').selectOption('example');await navigateWorkspace(page,"map");await navigateWorkspace(page,'release');
 const open=page.getByRole('button',{name:'Open proposed plan CM-6 · Application UID/GID hardening',exact:true});await open.click();
 const drawer=page.getByTestId('plan-proposal');await drawer.getByLabel('Milestone target',{exact:true}).fill('2026-10-20');await drawer.getByRole('button',{name:'Accept proposed draft',exact:true}).click();await expect(drawer.getByRole('button',{name:'Download OSCAL plan of action'})).toBeEnabled();await drawer.getByRole('button',{name:'Close proposed plan'}).click();
 let release!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;});let intercepted!:()=>void;const arrived=new Promise<void>(resolve=>{intercepted=resolve;});
 await page.route('**/api/remediation?key=binder.plan-proposals*',async route=>{const response=await route.fetch();intercepted();await held;await route.fulfill({response});});
 await page.reload();await arrived;await expect(open).toBeVisible();await expect(open).toBeDisabled();await expect(drawer).toHaveCount(0);
 await navigateWorkspace(page,'map');await page.locator('[data-control-id="CM-6"]').click();const summary=page.getByTestId('proposed-plan-summary');await expect(summary.getByRole('button',{name:'Loading saved plan…',exact:true})).toBeDisabled();
 release();await expect(summary.getByRole('button',{name:'Open plan of action',exact:true})).toBeEnabled();await summary.getByRole('button',{name:'Open plan of action',exact:true}).click();await expect(drawer.getByLabel('Milestone target',{exact:true})).toHaveValue('2026-10-20');
});
