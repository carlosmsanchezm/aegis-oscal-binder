import {expect,type Page} from '@playwright/test';
/** Measure painted paths in CSS pixels with their rendered transform.
 * Gutter routes retain family and control clearance. Curved fans may cross
 * blank family fills while clearing every unrelated control card.
 * Route shape and endpoint identity are independently asserted. */
export async function measureMapRoutes(page:Page){
 return page.locator('.pmap-layer').evaluate(layer=>{
  const svg=layer.querySelector<SVGSVGElement>('.pmap-wires')!;
  const screenRect=(el:Element,id:string|undefined)=>{const r=el.getBoundingClientRect();return {id,x:r.left,y:r.top,w:r.width,h:r.height};};
  const controls=Array.from(layer.querySelectorAll<HTMLElement>('[data-control-id]')).map(el=>screenRect(el,el.dataset.controlId));
  const families=Array.from(layer.querySelectorAll<SVGRectElement>('[data-family-box]')).map(el=>screenRect(el,el.dataset.familyBox));
  const canvas=svg.getBoundingClientRect();
  const inside=(p:DOMPoint,b:{x:number;y:number;w:number;h:number},margin=0)=>p.x>=b.x-margin&&p.x<=b.x+b.w+margin&&p.y>=b.y-margin&&p.y<=b.y+b.h+margin;
  const paths=Array.from(svg.querySelectorAll<SVGPathElement>('path[data-rel="related"],path[data-rel="family-bundle"]'));
  const problems=paths.flatMap(path=>{
   const owners=[path.dataset.from,path.dataset.to],length=path.getTotalLength(),matrix=path.getScreenCTM();
   if(length===0||!matrix)return [{owners,kind:'empty route'}];
   const fan=path.dataset.routing==='fan';
   if(!fan && /[CQ]/i.test(path.getAttribute('d')??''))return [{owners,kind:'not a gutter channel'}];
   const scale=Math.max(Math.hypot(matrix.a,matrix.b),Math.hypot(matrix.c,matrix.d));
   const clearance=6*scale,parallelClearance=12*scale;
   // Flatten curves within a tenth of a CSS pixel, then check whole segments.
   // Long wrapped maps need exact segment checks instead of millions of samples.
   const points:DOMPoint[]=[];
   const tokens=(path.getAttribute('d')??'').match(/[MLCQHVZ]|-?\d*\.?\d+(?:e[+-]?\d+)?/gi)??[];
   let cursor=0,current=new DOMPoint(0,0),origin=current;
   const transformed=(p:DOMPoint)=>p.matrixTransform(matrix);
   const distance=(p:DOMPoint,a:DOMPoint,b:DOMPoint)=>{
    const dx=b.x-a.x,dy=b.y-a.y,t=Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.y-a.y)*dy)/(dx*dx+dy*dy||1)));
    return Math.hypot(p.x-a.x-t*dx,p.y-a.y-t*dy);
   };
   const midpoint=(a:DOMPoint,b:DOMPoint)=>new DOMPoint((a.x+b.x)/2,(a.y+b.y)/2);
   function flatten(a:DOMPoint,b:DOMPoint,c:DOMPoint,d:DOMPoint,depth=0){
    if(depth>=16||Math.max(distance(b,a,d),distance(c,a,d))<=.1){points.push(d);return;}
    const ab=midpoint(a,b),bc=midpoint(b,c),cd=midpoint(c,d),abc=midpoint(ab,bc),bcd=midpoint(bc,cd),middle=midpoint(abc,bcd);
    flatten(a,ab,abc,middle,depth+1);flatten(middle,bcd,cd,d,depth+1);
   }
   while(cursor<tokens.length){
    const command=tokens[cursor++].toUpperCase();
    const point=()=>new DOMPoint(Number(tokens[cursor++]),Number(tokens[cursor++]));
    if(command==='M'){current=point();origin=current;points.push(transformed(current));}
    else if(command==='L'){current=point();points.push(transformed(current));}
    else if(command==='C'){const b=point(),c=point(),d=point();flatten(transformed(current),transformed(b),transformed(c),transformed(d));current=d;}
    else if(command==='Q'){const q=point(),d=point();flatten(transformed(current),transformed(new DOMPoint(current.x+2*(q.x-current.x)/3,current.y+2*(q.y-current.y)/3)),transformed(new DOMPoint(d.x+2*(q.x-d.x)/3,d.y+2*(q.y-d.y)/3)),transformed(d));current=d;}
    else if(command==='H'){current=new DOMPoint(Number(tokens[cursor++]),current.y);points.push(transformed(current));}
    else if(command==='V'){current=new DOMPoint(current.x,Number(tokens[cursor++]));points.push(transformed(current));}
    else if(command==='Z'){current=origin;points.push(transformed(current));}
    else return [{owners,kind:'unsupported path command',d:path.getAttribute('d')}];
   }
   const stroke=parseFloat(getComputedStyle(path).strokeWidth)*scale/2;
   const intersects=(a:DOMPoint,b:DOMPoint,box:typeof controls[number],margin:number)=>{
    let low=0,high=1;
    for(const [start,delta,min,max] of [[a.x,b.x-a.x,box.x-margin,box.x+box.w+margin],[a.y,b.y-a.y,box.y-margin,box.y+box.h+margin]]){
     if(Math.abs(delta)<1e-9){if(start<min||start>max)return false;continue;}
     const t1=(min-start)/delta,t2=(max-start)/delta;low=Math.max(low,Math.min(t1,t2));high=Math.min(high,Math.max(t1,t2));if(low>high)return false;
    }return true;
   };
   const range=(box:typeof controls[number],source:boolean,target:boolean,margin:number)=>{
    let first=0,last=points.length-1;
    if(source)while(first<points.length&&inside(points[first],box,margin))first++;
    if(target)while(last>=0&&inside(points[last],box,margin))last--;
    return {first:first+1,last};
   };
   for(const box of fan?[]:[...families,...controls]){
    const family=families.includes(box),source=owners[0]===box.id||family&&owners[0]?.split('-')[0]===box.id,target=owners[1]===box.id||family&&owners[1]?.split('-')[0]===box.id;
    const {first,last}=range(box,source,target,clearance+stroke);
    const edges=[{axis:'x',at:box.y,lo:box.x,hi:box.x+box.w},{axis:'x',at:box.y+box.h,lo:box.x,hi:box.x+box.w},{axis:'y',at:box.x,lo:box.y,hi:box.y+box.h},{axis:'y',at:box.x+box.w,lo:box.y,hi:box.y+box.h}] as const;
    for(const edge of edges){let run=0;for(let i=first;i<=last;i++){
     const a=points[i-1],b=points[i],horizontal=edge.axis==='x',alongA=horizontal?a.x:a.y,alongB=horizontal?b.x:b.y,normalA=horizontal?a.y:a.x,normalB=horizontal?b.y:b.x;
     const parallel=Math.abs(normalA-normalB)<.05,near=Math.max(Math.abs(normalA-edge.at),Math.abs(normalB-edge.at))<=parallelClearance+stroke+.5;
     const overlap=Math.max(0,Math.min(Math.max(alongA,alongB),edge.hi)-Math.max(Math.min(alongA,alongB),edge.lo));run=parallel&&near&&overlap>0?run+overlap:0;
     if(run>12)return [{owners,kind:'parallel edge clearance '+box.id,run,x:b.x,y:b.y,d:path.getAttribute('d')}];
    }}
   }
   if(!fan)for(const box of families){
    const source=owners[0]?.split('-')[0]===box.id,target=owners[1]?.split('-')[0]===box.id,{first,last}=range(box,source,target,clearance+stroke);
    if(first>points.length||last<0)return [{owners,kind:'never leaves family '+box.id}];
    for(let i=first;i<=last;i++)if(intersects(points[i-1],points[i],box,clearance+stroke))return [{owners,kind:'family clearance '+box.id,d:path.getAttribute('d')}];
   }
   for(const p of points)if(p.x<canvas.left||p.x>canvas.right||p.y<canvas.top||p.y>canvas.bottom)return [{owners,kind:'outside canvas',x:p.x,y:p.y}];
   for(const box of controls.filter(box=>!owners.includes(box.id)))for(let i=1;i<points.length;i++)if(intersects(points[i-1],points[i],box,(fan?2*scale:clearance)+stroke+.1))return [{owners,kind:'control clearance '+box.id,d:path.getAttribute('d')}];
   return [];
  });
  return {count:paths.length,problems,families,controls,routingPolicies:{units:"diagram pixels, scaled through each path screen transform",legacyBus:{familyClearance:6,controlClearance:6,parallelClearance:12},fan:{controlClearance:2,familyFills:'Round 29b context; headings painted above curves',shapeGuard:'independent dashed curves or held gutters per related card'}},viewport:{width:innerWidth,height:innerHeight},routes:paths.map(p=>({from:p.dataset.from,to:p.dataset.to,d:p.getAttribute('d')}))};
 });
}
export async function expectMapRoutes(page:Page){
 // The results-first default hides untouched families; route geometry is checked after explicit expansion.
 const untouched=page.getByRole('checkbox',{name:'Show untouched controls'});
 if(await untouched.count() && !(await untouched.isChecked()))await untouched.check();
 const focus=page.locator('[data-family-focus]');
 await expect(focus).toHaveCount(0); // BUI-024 removes the family focus rectangle.
 const selectedFamily=page.locator('[data-family-box][data-selected="true"]');
 if(await page.getByTestId('package-map').getAttribute('data-layout-engine')==='round21'&&await selectedFamily.count()){
  const family=await selectedFamily.getAttribute('data-family-box');
  await expect(page.locator('path[data-rel="related"],path[data-rel="family-bundle"]')).toHaveCount(0);
  await expect.poll(()=>page.locator('.pmap-control').evaluateAll((nodes,family)=>nodes.filter(node=>node.getAttribute('data-family')!==family).every(node=>getComputedStyle(node).opacity==='0.5'),family)).toBe(true);
  const result=await measureMapRoutes(page);expect(result.problems).toEqual([]);return result;
 }
 await expect(page.locator('path[data-rel="related"],path[data-rel="family-bundle"]').first()).toBeAttached();
 // ResizeObserver settles the panel width after selection; an empty route
 // must disappear before inspecting the final painted geometry.
 await expect(page.locator('path[data-rel="related"][d=""]')).toHaveCount(0);
 const result=await measureMapRoutes(page);expect(result.count).toBeGreaterThan(0);expect(result.problems).toEqual([]);return result;
}
