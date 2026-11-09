import {test,expect,type Page} from '@playwright/test';
import {navigateWorkspace} from './helpers/navigation';
async function load(page:Page,system:'podinfo'|'boutique'){
 await page.goto('/planning');await page.getByRole('radio',{name:/FedRAMP Rev5/}).check();
 if(system==='podinfo'){await page.getByLabel('Evidence system').selectOption('example');await navigateWorkspace(page,"map");} else{await page.getByLabel('Evidence system').selectOption('captured-reference');await page.getByRole('button',{name:'Load captured Online Boutique evidence'}).click();await navigateWorkspace(page,"map");}
 await page.locator(`[data-control-id="${system==='podinfo'?'CM-6':'AC-6'}"]`).click();await expect(page.getByTestId('pipeline-control-panel')).toBeVisible();
}
test('New package form disables upload without a file and explains held staging before importing',async({page})=>{
 await load(page,'podinfo');await navigateWorkspace(page,'export');await page.getByRole('button',{name:'Load sample SSP for this workspace'}).click();await page.getByRole('button',{name:'New package',exact:true}).click();const upload=page.getByRole('button',{name:'Upload OSCAL',exact:true});await expect(upload).toBeDisabled();
 let release!:()=>void,seen!:()=>void;const held=new Promise<void>(r=>release=r),requested=new Promise<void>(r=>seen=r);await page.route('**/samples/sample-oscal-ssp-rev5.json',async route=>{seen();await held;await route.continue();});await page.locator('summary').filter({hasText:'More starting points'}).click();await page.getByRole('button',{name:/^Stage sample SSP/}).click();await requested;
 try{await expect(upload).toBeDisabled();await upload.dispatchEvent('click');await expect(page.getByRole('status').filter({hasText:'Preparing sample… Upload is available when the file is staged.'})).toBeVisible();await expect(page.getByText('FILE_REQUIRED',{exact:true})).toHaveCount(0);}finally{release();}
 await expect(page.getByRole('status').filter({hasText:'Sample staged:'})).toBeVisible();await expect(upload).toBeEnabled();await upload.click();await expect(page.getByRole('button',{name:'New package',exact:true})).toBeVisible();await expect(page.getByLabel('Evidence system')).toHaveValue('example');
});
test('a package uploaded on an empty workspace is the same package on planning and exposes New package',async({page})=>{
 await page.goto('/workspace');await page.getByRole('radio',{name:/FedRAMP Rev5/}).check();const details=page.locator('summary').filter({hasText:'More starting points'});if(await details.count())await details.click();await page.getByRole('button',{name:/^Stage sample SSP/}).click();await expect(page.getByRole('status').filter({hasText:'Sample staged:'})).toBeVisible();await page.getByRole('button',{name:'Upload OSCAL',exact:true}).click();await expect(page.getByRole('button',{name:'New package',exact:true})).toBeVisible();await page.goto('/planning');await expect(page.getByRole('button',{name:'New package',exact:true})).toBeVisible();await expect(page.getByTestId('planning-empty')).toHaveCount(0);await page.reload();await expect(page.getByRole('button',{name:'New package',exact:true})).toBeVisible();
});
