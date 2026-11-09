import {referenceAuthorizationPlan,referencePlanCount} from "./helpers/collector-reference";
import {expect, test} from '@playwright/test';
import {readFile, writeFile} from 'node:fs/promises';
import {navigateWorkspace} from './helpers/navigation';
import {CCM_EXAMPLE, summaryForSession} from '../lib/aegis/pipeline-evidence';

const viewports=[{width:1280,height:800},{width:1366,height:768},{width:1440,height:900}];
for(const viewport of viewports) for(const system of ['podinfo','boutique'] as const) test(`${system} ${viewport.width}x${viewport.height}: inventory → ranked map → person decision → OSCAL`,async({page},info)=>{
 await page.setViewportSize(viewport);
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('/planning');
 const counts:number[]=[];
 await page.exposeFunction('recordLoadedCount',(count:number)=>counts.push(count));
 await page.evaluate(()=>{new MutationObserver(()=>{const node=document.querySelector('[data-testid="binder-summary"] [data-testid="artifact-arrival-count"]');if(node)(window as any).recordLoadedCount(Number(node.textContent?.match(/^(\d+)/)?.[1]));}).observe(document.body,{subtree:true,childList:true,characterData:true});});
 if(system==='podinfo') await page.getByLabel('Evidence system').selectOption('example');
 else {
  await navigateWorkspace(page,'connections');
  const arrivals:string[]=[];
  await page.exposeFunction('recordArtifactArrival',(text:string)=>arrivals.push(text));
  await page.evaluate(()=>{new MutationObserver(()=>{const node=document.querySelector('[data-testid="artifact-arrival-count"]');if(node)(window as any).recordArtifactArrival(node.textContent);}).observe(document.body,{subtree:true,childList:true,characterData:true});});
  await page.getByRole('button',{name:'Load captured Online Boutique evidence',exact:true}).click();
 }
 await expect(page.getByTestId('workspace-navigation')).toHaveAttribute('data-current-view','release');
 const summary=page.getByTestId('binder-summary');await expect(summary).toBeVisible();await expect(summary.getByRole("heading",{name:"What this system gave the binder"})).toBeInViewport();
 await expect(summary.getByTestId('artifact-arrival-count')).toContainText('complete');
 const total=system==='podinfo'?274:197;
 await expect(summary.getByTestId('artifact-arrival-count')).toContainText(`${total} artifacts loaded`);
 expect(new Set(counts).size).toBeGreaterThan(1);
 expect(Math.max(...counts)).toBe(total);
 expect(counts.every((count,index)=>index===0||count>=counts[index-1])).toBe(true);
 if(system==='podinfo') {await summary.getByText("Pipeline check artifacts · 8",{exact:true}).click();await expect(summary.locator('[data-summary-check]')).toHaveCount(8);for(const artifact of CCM_EXAMPLE.checks.map(c=>c.artifact))await expect(summary).toContainText(artifact);}
 else {await expect(summary).toContainText('RBAC');const families=await summary.locator('[data-summary-artifact]').evaluateAll(ns=>ns.map(n=>n.textContent).join(' '));expect(families).toMatch(/AC/);expect(families).toMatch(/CM|IA/);}
 const evidence=process.env.DEMO_STORY_EVIDENCE;
 async function shot(scene:string){await page.screenshot({path:evidence?`${evidence}/${system}-${viewport.width}-${scene}.png`:info.outputPath(`${scene}.png`),fullPage:true});}
 await shot('inventory');
 const touchedFamilies=Number(await summary.getByTestId("summary-family-coverage").getAttribute("data-touched-families"));
 await navigateWorkspace(page,'map');
 await expect(page.getByRole('checkbox',{name:'Show untouched controls'})).not.toBeChecked();
 const blankFamilies=await page.locator('[data-family-box]').evaluateAll(ns=>ns.filter(n=>n.getAttribute('data-linked')==='0' && Number(n.getAttribute('data-proposed')??0)===0).length);
 expect(blankFamilies).toBe(0);
 await expect(page.locator("[data-family-box]")).toHaveCount(touchedFamilies);
 await expect(page.getByTestId('map-next-work')).toContainText('Next work');
 await shot('results');
 await page.getByRole('checkbox',{name:'Show untouched controls'}).check();
 expect(await page.locator('[data-family-box]').count()).toBeGreaterThan(system==='podinfo'?8:1);
 await page.getByRole('checkbox',{name:'Show untouched controls'}).uncheck();
 const control=system==='podinfo'?'CM-6':'AC-6';
 await page.locator(`[data-control-id="${control}"]`).click();
 await page.getByTestId('pipeline-control-panel').getByRole('button',{name:'Open plan of action',exact:true}).click();
 const drawer=page.getByTestId('plan-proposal');
 await expect(drawer.getByText('What is wrong',{exact:true})).toBeVisible();
 await expect(drawer.getByText('Why it matters',{exact:true})).toBeVisible();
 await expect(drawer.getByRole('button',{name:'Confirm closure',exact:true})).toBeDisabled();
 await drawer.getByLabel('Who owns it').fill('Throwaway demo owner');
 await drawer.getByRole('button',{name:'Accept proposed draft',exact:true}).click();
 if(system==='podinfo') {
  await expect(drawer).toContainText('Closure proposed');
  await expect(drawer.locator('ol li')).toHaveCount(3);
  await drawer.getByRole('button',{name:'Confirm closure',exact:true}).click();
  await expect(drawer.getByRole('alert')).toContainText('Enter your name and a reason');
  await drawer.getByLabel('Closure name').fill('Throwaway demo reviewer');
  await drawer.getByLabel('Closure reason').fill('Reviewed all three passing measurements.');
  await drawer.getByRole('button',{name:'Confirm closure',exact:true}).click();
  await expect(drawer).toContainText('Closed · Closure confirmed by a person');
 } else {
  await expect(drawer).toContainText('retest expired');
  await expect(drawer.getByRole('button',{name:'Confirm closure',exact:true})).toBeDisabled();
  await expect(drawer).not.toContainText('Closure proposed');
 }
 await shot(system==='podinfo'?'closed':'expired-retest');
 const downloadEvent=page.waitForEvent('download');
 await drawer.getByRole('button',{name:'Download OSCAL plan of action'}).click();
 const downloaded=await downloadEvent, raw=await readFile((await downloaded.path())!,'utf8'), body=JSON.parse(raw)['plan-of-action-and-milestones'];
 if(evidence)await writeFile(`${evidence}/${system}-${viewport.width}-poam.json`,raw);
 expect(body.risks[0].status).toBe(system==='podinfo'?'closed':'open');
 if(system==='podinfo') {
  expect(body['poam-items'][0].props).toContainEqual(expect.objectContaining({name:'completion-date',value:expect.any(String)}));
  expect(body['poam-items'][0].props).toContainEqual(expect.objectContaining({name:'closure-reviewer',value:'Throwaway demo reviewer'}));
 }
 const plain=JSON.parse(body['poam-items'][0].props.find((p:any)=>p.name==='plain-plan-record').remarks).plain;
 expect(plain.whoOwnsIt).toBe('Throwaway demo owner');
 expect(plain.status).toBe(system==='podinfo'?'Closed':'Accepted');
 await drawer.getByRole('button',{name:'Close proposed plan'}).click();
 await navigateWorkspace(page,'release');
 await page.getByLabel('Import OSCAL plan JSON').setInputFiles({name:'round-trip.json',mimeType:'application/json',buffer:Buffer.from(raw)});
 await page.getByRole('button',{name:system==='podinfo'?'Open proposed plan CM-6 · Application UID/GID hardening':referenceAuthorizationPlan,exact:true}).click();
 await expect(drawer.getByLabel('Who owns it')).toHaveValue('Throwaway demo owner');
 if(system==='podinfo')await expect(drawer).toContainText('Closed · Closure confirmed by a person');
 await drawer.getByRole('button',{name:'Close proposed plan'}).click();
 if(system==='podinfo') {await navigateWorkspace(page,'map');await page.getByRole('button',{name:'Close panel',exact:true}).click();await expect(page.getByTestId('map-next-work')).toContainText('CM-6 · Closed');}
 expect(errors).toEqual([]);
});

test('artifact acceptance adds one linked control and records a reviewer and time',async({page})=>{
 await page.goto('/planning');await page.getByLabel('Evidence system').selectOption('example');
 const panel=page.getByTestId('mapping-proposals');
 // Configuration raw output is already received but has no producer-declared links.
 const proposal=panel.locator('[data-proposal-artifact="configuration.raw.json"]');
 while(!(await proposal.isVisible()))await panel.getByRole('button',{name:'Next proposals'}).click();
 await panel.getByLabel('Mapping reviewer').fill('Throwaway mapping reviewer');
 await proposal.getByLabel('Control to accept for configuration.raw.json').selectOption('CM-2');
 await navigateWorkspace(page,'map');
 const before=await page.getByTestId('map-rollup-summary').innerText();
 const linked=Number(before.match(/(\d+) linked/)![1]);
 await navigateWorkspace(page,'release');
 while(!(await proposal.isVisible()))await panel.getByRole('button',{name:'Next proposals'}).click();
 await panel.getByLabel('Mapping reviewer').fill('Throwaway mapping reviewer');
 await proposal.getByLabel('Control to accept for configuration.raw.json').selectOption('CM-2');
 await proposal.getByRole('button',{name:'Accept mapping for configuration.raw.json'}).click();
 await expect(proposal).toHaveAttribute('data-decision','accepted');
 await expect(proposal).toContainText('Throwaway mapping reviewer');
 await expect(proposal).toContainText(/\d{4}-\d{2}-\d{2}T/);
 await navigateWorkspace(page,'map');
 await expect(page.getByTestId('map-rollup-summary')).toContainText(`${linked+1} linked`);
});

test('a newly imported artifact proposes mappings and one reviewer acceptance adds one linked control',async({page})=>{
 await page.goto('/planning?view=connections');
 await page.getByRole('button',{name:'Load captured Online Boutique evidence',exact:true}).click();
 await expect(page.getByTestId('binder-summary')).toBeVisible();
 const capture=await (await page.request.get('/api/builder/reference')).json();
 const event=JSON.parse(capture.events[1].rawEvent);
 event.run.id='new-artifact-regression';
 const original=event.artifacts.find((a:any)=>a.name==='namespace-rbac.json');
 event.artifacts.push({...original,name:'namespace-rbac-addition.json'});
 await navigateWorkspace(page,'connections');
 const published=page.waitForResponse(r=>r.url().endsWith('/imports')&&r.request().method()==='POST');
 await page.getByLabel('Import collector event JSON').setInputFiles({name:'new-artifact.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(event))});
 const receipt=await published;expect(receipt.status()).toBe(201);
 const id=(await receipt.json()).evidenceId;
 await navigateWorkspace(page,'release');
 await expect(page.getByLabel('Release selection')).toContainText(id.slice(0,8));
 const option=await page.getByLabel('Release selection').locator('option').evaluateAll((ns,needle)=>ns.map(n=>(n as HTMLOptionElement).value).find(value=>value.includes(needle)),id);
 await page.getByLabel('Release selection').selectOption(option!);
 const panel=page.getByTestId('mapping-proposals'), proposal=panel.locator('[data-proposal-artifact="namespace-rbac-addition.json"]');
 for(let i=0;i<6&&!(await proposal.isVisible());i++)await panel.getByRole('button',{name:'Next proposals'}).click();
 await expect(proposal).toContainText('New artifact');
 await panel.getByLabel('Mapping reviewer').fill('Throwaway artifact reviewer');
 await proposal.getByLabel('Control to accept for namespace-rbac-addition.json').selectOption('CM-5');
 await proposal.getByRole('button',{name:'Accept mapping for namespace-rbac-addition.json'}).click();
 await expect(proposal).toHaveAttribute('data-decision','accepted');
 await expect(proposal).toContainText('Throwaway artifact reviewer');
 await navigateWorkspace(page,'map');
 await expect(page.getByTestId('map-rollup-summary')).toContainText('2 linked');
 await expect(page.locator('[data-control-id="CM-5"]')).toContainText('linked');
});
