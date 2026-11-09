import {expect, type Page} from '@playwright/test';
import type {PackageState} from '../../lib/aegis/types';

/** Wait for the approved finite glide, rather than auditing intermediate boxes. */
export async function settleMap(page:Page) {
 await page.getByTestId('package-map').evaluate(async map=>{
  await document.fonts.ready;
  for(let pass=0;pass<2;pass++) {
   await new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())));
   await Promise.all(map.getAnimations({subtree:true})
    .filter(animation=>animation.effect?.getComputedTiming().iterations!==Infinity)
    .map(animation=>animation.finished.catch(()=>{})));
  }
 });
}

/** Approved 3b grid routes, including bounded rounded corners and arrowheads. */
export async function expectPlanningRoutes(page:Page) {
 await settleMap(page);
 const result=await page.getByTestId('package-map').evaluate(map=>{
  const svg=map.querySelector<SVGSVGElement>('.pmap-wires')!,width=Number(svg.getAttribute('width')),height=Number(svg.getAttribute('height'));
  const top=Math.min(...[...map.querySelectorAll('[data-family-box]')].map(node=>Number(node.getAttribute('y'))),...[...map.querySelectorAll<HTMLElement>('[data-focus-hub=true]')].map(node=>parseFloat(node.style.top)));
  const paths=[...svg.querySelectorAll<SVGPathElement>('path[data-rel]')];
  const faults:string[]=[];
  for(const path of paths) {
   const d=path.getAttribute('d')??'',label=`${path.dataset.from}->${path.dataset.to}`;
   if(!d||!path.getTotalLength())faults.push(`${label} empty`);
   if(!path.getAttribute('marker-end')&&!path.getAttribute('marker-start'))faults.push(`${label} arrowhead missing`);
   const tokens=d.match(/[A-Za-z]|-?\d+(?:\.\d+)?/g)??[];let cursor=0,x=0,y=0;
   while(cursor<tokens.length) {
    const command=tokens[cursor++],nx=Number(tokens[cursor++]),ny=Number(tokens[cursor++]);
    if(command==='L'&&Math.abs(nx-x)>.01&&Math.abs(ny-y)>.01)faults.push(`${label} diagonal run`);
    if(command==='Q') {
     const tx=Number(tokens[cursor++]),ty=Number(tokens[cursor++]);
     const legs=[Math.hypot(nx-x,ny-y),Math.hypot(tx-nx,ty-ny)];
     if(legs.some(length=>length>8.01)||Math.abs((nx-x)*(tx-nx)+(ny-y)*(ty-ny))>.01)faults.push(`${label} unbounded corner`);
     x=tx;y=ty;
    }else {if(command!=='M'&&command!=='L')faults.push(`${label} unsupported ${command}`);x=nx;y=ny;}
   }
   // SVG computes the exact continuous curve bounds, including Q extrema.
   // This checks more than two-unit sampling without repeated path traversal.
   const bounds=path.getBBox();
   if(bounds.x<-.5||bounds.x+bounds.width>width+.5||bounds.y<top-1||bounds.y+bounds.height>height+.5)faults.push(`${label} outside canvas`);
  }
  return {count:paths.length,faults};
 });
 expect(result.faults).toEqual([]);
 return result;
}

export async function mapMembership(page:Page) {
 return page.getByTestId('package-map').locator('[data-control-id]').evaluateAll(nodes=>nodes.map(node=>node.getAttribute('data-control-id')!).sort());
}

/** Coordinates in map units: Fit may change the view transform, never membership. */
export async function mapUnitGeometry(page:Page) {
 await settleMap(page);
 return page.getByTestId('package-map').evaluate(map=>({
  controls:[...map.querySelectorAll<HTMLElement>('[data-control-id]')].map(node=>({id:node.dataset.controlId,box:[node.style.left,node.style.top,node.style.width,node.style.height]})).sort((a,b)=>a.id!.localeCompare(b.id!)),
  families:[...map.querySelectorAll('[data-family-box]')].map(node=>({id:node.getAttribute('data-family-box'),box:['x','y','width','height'].map(name=>node.getAttribute(name))})).sort((a,b)=>a.id!.localeCompare(b.id!)),
 }));
}

export async function expectPlanningFit(page:Page) {
 await settleMap(page);
 const faults=await page.getByTestId('package-map').evaluate(map=>{
  const stage=map.querySelector<HTMLElement>('[data-testid="map-stage"]')!,bounds=stage.getBoundingClientRect();
  const panel=document.querySelector('[data-testid="pipeline-control-panel"],[data-testid="map-family-panel"],[data-testid="map-node-panel"]')?.getBoundingClientRect();
  const right=panel?Math.min(bounds.right,panel.left):bounds.right;
  const problems:string[]=[];
  for(const node of map.querySelectorAll('[data-control-id],[data-family-box],.pmap-evidence')) {
   const r=node.getBoundingClientRect();
   if(r.left<bounds.left-1||r.right>right+1||r.top<bounds.top-1||r.bottom>bounds.bottom+1)problems.push(`${node.getAttribute('data-control-id')??node.getAttribute('data-family-box')??node.textContent} outside fitted view`);
  }
  const layerStyle=getComputedStyle(map.querySelector('.pmap-layer')!);
  const scale=layerStyle.transform==='none'?1:new DOMMatrixReadOnly(layerStyle.transform).a;
  const zoom=Number.parseFloat(layerStyle.zoom)||1;
  const displayedZoom=Number.parseFloat(map.querySelector('.pmap-zoom-pct')?.textContent??'NaN');
  if(scale*zoom>1||displayedZoom>100)problems.push('Fit exceeds 100%');
  const dock=map.querySelector('.pmap-zoom-dock')?.getBoundingClientRect();
  if(dock&&panel&&dock.right>panel.left+1)problems.push('zoom dock under panel');
  return problems;
 });
 expect(faults).toEqual([]);
}

export async function expectPlanningHub(page:Page,id:string) {
 const hub=page.getByTestId('package-map').locator(`[data-control-id="${id}"]`);
 await expect(hub).toHaveAttribute('aria-pressed','true');
 await expect(hub).toHaveClass(/\bpmap-focus-hub\b/);
 await expect(page.getByTestId('pipeline-control-panel')).toBeVisible();
 await expectPlanningFit(page);
}

/** Owner filtering replaced role nodes; assert assignments against the real package. */
export async function suppliedPackage(page:Page):Promise<PackageState> {
 const response=await page.request.get('/api/package');expect(response.ok()).toBe(true);
 return (await response.json()).packageState;
}

export async function expectOwnerFilter(page:Page,pkg:PackageState,owner:string) {
 const map=page.getByTestId('package-map');
 await map.getByLabel('Owner',{exact:true}).selectOption(owner);
 await page.mouse.move(0,0);await settleMap(page);
 const controls=await map.locator('[data-control-id]').evaluateAll(nodes=>nodes.map(node=>({id:node.getAttribute('data-control-id')!,opacity:Number(getComputedStyle(node).opacity),dimmed:node.classList.contains('l1-dim')||node.classList.contains('hover-dim')})));
 for(const control of controls) {
  const assigned=pkg.controls.find(row=>row.id===control.id)!;
  const matches=!owner||assigned.responsibleRoleId===owner||assigned.responsibleRoleIds.includes(owner);
  // Other legitimate selection/hover dimming may still apply to owner matches.
  if(!matches)expect(control.opacity,`${owner} fades ${control.id}`).toBe(.5);
  else expect(control.opacity,`${owner} preserves assigned ${control.id}`).toBe(control.dimmed?.5:1);
 }
 await expect(map.locator('.pmap-role,[data-testid="role-card"],path[data-rel="role"]')).toHaveCount(0);
 await expect(map.getByRole('button',{name:'Roles',exact:true})).toHaveCount(0);
 expect(controls.map(row=>row.id).sort()).toEqual(pkg.controls.map(row=>row.id).sort());
}
