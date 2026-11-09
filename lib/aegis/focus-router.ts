/** Revision 3b: bounded orthogonal routing. There are no cells above the first
 * family, outside the map, or below the canvas. Only endpoint families may be entered. */
export type Rect={x:number;y:number;w:number;h:number};
type Lane=Rect&{id:string;headerH:number};
type Card=Rect&{id:string;family:string};
type Attachment=Rect&{id:string;uuid?:string;controlIds:string[]};
type Port=[cell:number,direction:number];
type Point=[number,number];
export type GridRoute={d:string;mid:{x:number;y:number};cells:number[]};
export class FocusRouter {
 readonly step=8;readonly columns:number;readonly rows:number;readonly top:number;
 private hard:Uint8Array;private family:Int16Array;private used:Uint16Array;
 private familyIndex=new Map<string,number>();private cache=new Map<string,GridRoute|null>();
 private trees=new Map<string,Map<string,string>>();
 private obstacles:Rect[];
 private costs:Float64Array;private parents:Int32Array;private stamps:Uint32Array;private closed:Uint32Array;private generation=0;
 constructor(width:number,top:number,bottom:number,lanes:Lane[],cards:Card[],attachments:Attachment[],hub:Rect|null){
  this.obstacles=[...cards,...attachments,...lanes.map(l=>({...l,h:l.headerH+24}))];
  this.top=top-4;this.columns=Math.floor(width/8);this.rows=Math.max(2,Math.floor((bottom-this.top)/8));
  const size=this.columns*this.rows;this.hard=new Uint8Array(size);this.family=new Int16Array(size).fill(-1);this.used=new Uint16Array(size);
  this.costs=new Float64Array(size*4);this.parents=new Int32Array(size*4);this.stamps=new Uint32Array(size*4);this.closed=new Uint32Array(size*4);
  const fill=(box:Rect,pad:number,write:(index:number)=>void)=>{
   const left=Math.max(0,Math.ceil((box.x-pad)/8-.5)),right=Math.min(this.columns-1,Math.floor((box.x+box.w+pad)/8-.5));
   const first=Math.max(0,Math.ceil((box.y-pad-this.top)/8-.5)),last=Math.min(this.rows-1,Math.floor((box.y+box.h+pad-this.top)/8-.5));
   for(let row=first;row<=last;row++)for(let col=left;col<=right;col++)write(row*this.columns+col);
  };
  for(let row=0;row<this.rows;row++){this.hard[row*this.columns]=1;this.hard[row*this.columns+this.columns-1]=1;}
  lanes.forEach((lane,index)=>{this.familyIndex.set(lane.id,index);fill(lane,3,i=>this.family[i]=index);fill({...lane,h:lane.headerH+24},3,i=>this.hard[i]=1);});
  for(const card of cards)fill(card,card.h<=26?1:3,i=>this.hard[i]=1);
  for(const box of attachments)fill(box,3,i=>this.hard[i]=1);
  if(hub)fill(hub,3,i=>this.hard[i]=1);
 }
 private x(cell:number){return cell%this.columns*8+4;}
 private y(cell:number){return Math.floor(cell/this.columns)*8+4+this.top;}
 private ports(box:Rect,allowed:Set<number>):Port[]{
  const pad=box.h<=26?1:3,left=Math.ceil((box.x-pad)/8-.5)-1,right=Math.floor((box.x+box.w+pad)/8-.5)+1;
  const top=Math.ceil((box.y-pad-this.top)/8-.5)-1,bottom=Math.floor((box.y+box.h+pad-this.top)/8-.5)+1,ports:Port[]=[];
  const add=(col:number,row:number,dir:number)=>{if(col<0||row<0||col>=this.columns||row>=this.rows)return;const cell=row*this.columns+col;if(!this.hard[cell]&&(this.family[cell]<0||allowed.has(this.family[cell])))ports.push([cell,dir]);};
  for(let col=left+2;col<right-1;col++){add(col,top,3);add(col,bottom,2);}
  for(let row=top+2;row<bottom-1;row++){add(left,row,1);add(right,row,0);}
  return ports;
 }
 private search(starts:[number,number,number][],goals:Map<number,number>,target:Rect,allowed:Set<number>,shared:Set<number>|null):number[]|null{
  const gen=++this.generation,cols=this.columns,rows=this.rows,heap:{score:number;state:number}[]=[];
  const push=(score:number,state:number)=>{let i=heap.length;heap.push({score,state});while(i>0){const p=(i-1)>>1;if(heap[p].score<=score)break;heap[i]=heap[p];i=p;}heap[i]={score,state};};
  const pop=()=>{const first=heap[0],last=heap.pop()!;if(heap.length){let i=0;while(i*2+1<heap.length){let child=i*2+1;if(child+1<heap.length&&heap[child+1].score<heap[child].score)child++;if(heap[child].score>=last.score)break;heap[i]=heap[child];i=child;}heap[i]=last;}return first;};
  const goalCells=[...goals.keys()];
  const heuristic=(cell:number)=>{
   const x=cell%cols,y=Math.floor(cell/cols);
   if(goalCells.length<=96)return Math.min(...goalCells.map(g=>Math.abs(x-g%cols)+Math.abs(y-Math.floor(g/cols))))*2.5;
   return 2.5*(Math.max(0,target.x/8-x-.5,x+.5-(target.x+target.w)/8)+Math.max(0,(target.y-this.top)/8-y-.5,y+.5-(target.y+target.h-this.top)/8));
  };
  for(const [cell,dir,cost] of starts){const state=cell*4+dir;if(this.stamps[state]!==gen||cost<this.costs[state]){this.stamps[state]=gen;this.costs[state]=cost;this.parents[state]=-1;push(cost+heuristic(cell),state);}}
  let end=-1,iterations=0;
  while(heap.length){
   iterations++;
   const {score,state}=pop(),cell=state>>2,dir=state&3,cost=this.costs[state];if(this.closed[state]===gen||score-heuristic(cell)>cost+1e-6)continue;this.closed[state]=gen;
   if(goals.has(cell)&&goals.get(cell)!==dir){end=state;break;}
   const x=cell%cols,y=Math.floor(cell/cols);
   for(let nextDir=0;nextDir<4;nextDir++){
    if((nextDir^1)===dir)continue;
    const nx=nextDir===0?x+1:nextDir===1?x-1:x,ny=nextDir===2?y+1:nextDir===3?y-1:y;
    if(nx<0||ny<0||nx>=cols||ny>=rows)continue;
    const next=ny*cols+nx;if(this.hard[next]||(this.family[next]>=0&&!allowed.has(this.family[next])))continue;
    const price=cost+(shared?.has(next)?.25:1+Math.min(3,this.used[next])*.3)+(nextDir!==dir?4:0),ns=next*4+nextDir;
    if(this.stamps[ns]!==gen||price<this.costs[ns]){this.stamps[ns]=gen;this.costs[ns]=price;this.parents[ns]=state;push(price+heuristic(next),ns);}
   }
  }
  if(end<0)return null;const cells:number[]=[];for(let state=end;state>=0;state=this.parents[state])cells.push(state>>2);return cells.reverse();
 }
 private edge(box:Rect,point:Point,dir:number):Point{return dir<2?[dir===0?box.x+box.w:box.x,point[1]]:[point[0],dir===2?box.y+box.h:box.y];}
 static path(points:Point[],obstacles:Rect[]=[]){
  const corners:Point[]=[points[0]];
  for(let i=1;i<points.length-1;i++){const a=corners.at(-1)!,b=points[i],c=points[i+1];if(!(Math.abs(a[0]-b[0])<.01&&Math.abs(b[0]-c[0])<.01||Math.abs(a[1]-b[1])<.01&&Math.abs(b[1]-c[1])<.01))corners.push(b);}
  corners.push(points.at(-1)!);let d=`M ${corners[0][0].toFixed(1)} ${corners[0][1].toFixed(1)}`;
  for(let i=1;i<corners.length;i++){const a=corners[i-1],b=corners[i],c=corners[i+1];if(!c){d+=` L ${b[0].toFixed(1)} ${b[1].toFixed(1)}`;continue;}
   let r=Math.min(8,Math.hypot(b[0]-a[0],b[1]-a[1])/2,Math.hypot(c[0]-b[0],c[1]-b[1])/2);
   // Grid segments clear every obstacle, but smoothing can cut a tight tile corner.
   // Reduce only that bend's radius until its quadratic also clears the real boxes.
   const nearby=obstacles.filter(o=>b[0]+r>o.x&&b[0]-r<o.x+o.w&&b[1]+r>o.y&&b[1]-r<o.y+o.h);
   const crosses=(radius:number)=>nearby.some(o=>[.125,.25,.375,.5,.625,.75,.875].some(t=>{
    const x=(1-t)**2*(b[0]-Math.sign(b[0]-a[0])*radius)+2*(1-t)*t*b[0]+t*t*(b[0]+Math.sign(c[0]-b[0])*radius);
    const y=(1-t)**2*(b[1]-Math.sign(b[1]-a[1])*radius)+2*(1-t)*t*b[1]+t*t*(b[1]+Math.sign(c[1]-b[1])*radius);
    return x>o.x&&x<o.x+o.w&&y>o.y&&y<o.y+o.h;
   }));
   while(r>.125&&crosses(r))r/=2;
   d+=` L ${(b[0]-Math.sign(b[0]-a[0])*r).toFixed(1)} ${(b[1]-Math.sign(b[1]-a[1])*r).toFixed(1)} Q ${b[0].toFixed(1)} ${b[1].toFixed(1)} ${(b[0]+Math.sign(c[0]-b[0])*r).toFixed(1)} ${(b[1]+Math.sign(c[1]-b[1])*r).toFixed(1)}`;
  }return {d,corners};
 }
 route(source:Rect,sourceFamily:string|null,target:Rect,targetFamily:string|null,key:string):GridRoute|null{
  const cacheKey=`${key}|${source.x},${source.y},${source.w}|${target.x},${target.y},${target.w}`;if(this.cache.has(cacheKey))return this.cache.get(cacheKey)!;
  const allowed=new Set<number>();for(const id of [sourceFamily,targetFamily])if(id&&this.familyIndex.has(id))allowed.add(this.familyIndex.get(id)!);
  const starts=this.ports(source,allowed),ends=this.ports(target,allowed);let result:GridRoute|null=null;
  if(starts.length&&ends.length){const cells=this.search(starts.map(([c,d])=>[c,d,0]),new Map(ends),target,allowed,null);if(cells){
   const points:Point[]=cells.map(c=>[this.x(c),this.y(c)]);points.unshift(this.edge(source,points[0],starts.find(([c])=>c===cells[0])![1]));points.push(this.edge(target,points.at(-1)!,ends.find(([c])=>c===cells.at(-1))![1]));
   for(const cell of cells)this.used[cell]++;const {d,corners}=FocusRouter.path(points,this.obstacles);let longest=0,mid={x:corners[0][0],y:corners[0][1]};for(let i=1;i<corners.length;i++){const length=Math.hypot(corners[i][0]-corners[i-1][0],corners[i][1]-corners[i-1][1]);if(length>longest){longest=length;mid={x:(corners[i][0]+corners[i-1][0])/2,y:(corners[i][1]+corners[i-1][1])/2};}}result={d,mid,cells};
  }}this.cache.set(cacheKey,result);return result;
 }
 /** Grow each attachment from its first trunk. Subsequent targets reuse that
  * trunk only outside families, retaining a single exit from the evidence box. */
 tree(source:Attachment|null,cards:Map<string,Card>,only?:ReadonlySet<string>):Map<string,string>{
  if(!source)return new Map();const key=`${source.uuid??source.id}|${only?[...only].sort().join(','):'*'}`;const prior=this.trees.get(key);if(prior)return prior;
  const result=new Map<string,string>();this.trees.set(key,result);
  const ids=source.controlIds.filter(id=>cards.has(id)&&(!only||only.has(id))).sort((a,b)=>{const distance=(id:string)=>{const c=cards.get(id)!;return Math.hypot(c.x+c.w/2-source.x-source.w/2,c.y+c.h/2-source.y-source.h/2);};return distance(a)-distance(b);});
  const paths:Point[][]=[],trunk=new Map<number,{path:number;at:number}>();
  for(const id of ids){const card=cards.get(id)!,allowed=new Set<number>();if(this.familyIndex.has(card.family))allowed.add(this.familyIndex.get(card.family)!);
   const ends=this.ports(card,allowed);if(!ends.length)continue;const first=!paths.length,ports=first?this.ports(source,allowed):[];
   const starts:[number,number,number][]=first?ports.map(([c,d])=>[c,d,0]):[...trunk.keys()].flatMap(c=>[0,1,2,3].map(d=>[c,d,0] as [number,number,number]));if(!starts.length)continue;
   const cells=this.search(starts,new Map(ends),card,allowed,first?null:new Set(trunk.keys()));if(!cells)continue;
   const endDir=ends.find(([c])=>c===cells.at(-1))![1];let points:Point[];
   if(first){points=cells.map(c=>[this.x(c),this.y(c)]);points.unshift(this.edge(source,points[0],ports.find(([c])=>c===cells[0])![1]));}
   else{const join=trunk.get(cells[0])!;points=[...paths[join.path].slice(0,join.at+1),...cells.slice(1).map(c=>[this.x(c),this.y(c)] as Point)];}
   points.push(this.edge(card,points.at(-1)!,endDir));const index=paths.length;paths.push(points);
   for(let i=1;i<points.length-1;i++){const cell=this.cellAt(points[i]);if(cell<0||this.family[cell]>=0)break;if(!trunk.has(cell))trunk.set(cell,{path:index,at:i});}
   for(const cell of cells)this.used[cell]++;result.set(id,FocusRouter.path(points,this.obstacles).d);
  }return result;
 }
 private cellAt(point:Point){const x=Math.floor(point[0]/8),y=Math.floor((point[1]-this.top)/8),cell=y*this.columns+x;return x>=0&&y>=0&&x<this.columns&&y<this.rows&&Math.abs(this.x(cell)-point[0])<.01&&Math.abs(this.y(cell)-point[1])<.01?cell:-1;}
}
