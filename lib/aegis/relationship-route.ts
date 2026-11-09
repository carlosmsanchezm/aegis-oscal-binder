type Rect={x:number;y:number;w:number;h:number};
type Point={x:number;y:number};
/** Route only selection relationships; control/family geometry and other connectors stay unchanged. */
export function relationshipRoute(start:Point,end:Point,boxes:Rect[],width:number,rank:number,exit=1,entry=1,height=Math.max(start.y,end.y,...boxes.map(r=>r.y+r.h))+16,clearance=1.2):string {
  // Transit uses centered corridors with the caller’s required clearance.
  const margin=clearance;
  const a=start,b=end;
  void exit;void entry;
  const obstacles=boxes.map(r=>({x:r.x-margin,y:r.y-margin,w:r.w+margin*2,h:r.h+margin*2}));
  const unique=(values:number[])=>[...new Set(values.map(v=>Math.round(v*100)/100))].sort((x,y)=>x-y);
  const centers=(axis:'x'|'y')=>{const ends=unique(boxes.flatMap(r=>axis==='x'?[r.x,r.x+r.w]:[r.y,r.y+r.h]));return ends.slice(1).map((v,i)=>(ends[i]+v)/2);};
  const xs=unique([a.x,b.x,7,width-7,...centers('x')].filter(x=>x>=2&&x<=width-2));
  const ys=unique([a.y,b.y,7,height-7,...centers('y')].filter(y=>y>=2&&y<=height-2));
  const nx=xs.length,ny=ys.length;
  const free=(p:Point,q:Point)=>!obstacles.some(r=>p.x===q.x?p.x>r.x&&p.x<r.x+r.w&&Math.max(p.y,q.y)>r.y&&Math.min(p.y,q.y)<r.y+r.h:p.y>r.y&&p.y<r.y+r.h&&Math.max(p.x,q.x)>r.x&&Math.min(p.x,q.x)<r.x+r.w);
  const point=(node:number):Point=>({x:xs[node%nx],y:ys[Math.floor(node/nx)]});
  if(a.x<2||b.x<2||a.x>width-2||b.x>width-2||a.y<2||b.y<2||a.y>height-2||b.y>height-2)return "";
  const from=ys.indexOf(Math.round(a.y*100)/100)*nx+xs.indexOf(Math.round(a.x*100)/100),to=ys.indexOf(Math.round(b.y*100)/100)*nx+xs.indexOf(Math.round(b.x*100)/100);
  const scores=new Float64Array(nx*ny*3).fill(Infinity),prev=new Int32Array(nx*ny*3).fill(-1);
  const heap:{key:number;score:number}[]=[];
  function push(item:{key:number;score:number}) {heap.push(item);let i=heap.length-1;while(i>0){const parent=(i-1)>>1;if(heap[parent].score<=item.score)break;heap[i]=heap[parent];i=parent;}heap[i]=item;}
  function pop(){const first=heap[0],last=heap.pop()!;if(heap.length){let i=0;while(i*2+1<heap.length){let child=i*2+1;if(child+1<heap.length&&heap[child+1].score<heap[child].score)child++;if(heap[child].score>=last.score)break;heap[i]=heap[child];i=child;}heap[i]=last;}return first;}
  const origin=from*3+2;scores[origin]=0;push({key:origin,score:0});let finish=-1;
  const edgeFree=new Map<string,boolean>();
  while(heap.length){const current=pop(),node=Math.floor(current.key/3),direction=current.key%3;if(current.score!==scores[current.key])continue;if(node===to){finish=current.key;break;}
    const ix=node%nx,iy=Math.floor(node/nx),p=point(node);
    for(const [dx,dy,d] of [[1,0,0],[-1,0,0],[0,1,1],[0,-1,1]]){const x=ix+dx,y=iy+dy;if(x<0||x>=nx||y<0||y>=ny)continue;const next=y*nx+x,q=point(next),edge=`${Math.min(node,next)}:${Math.max(node,next)}`;let clear=edgeFree.get(edge);if(clear===undefined){clear=free(p,q);edgeFree.set(edge,clear);}if(!clear)continue;
      const key=next*3+d,score=current.score+Math.abs(p.x-q.x)+Math.abs(p.y-q.y)+(direction!==2&&direction!==d?8:0);if(score>=scores[key])continue;scores[key]=score;prev[key]=current.key;push({key,score});
    }
  }
  // Never fall back to an unchecked curve across obstacles.
  if(finish<0)return "";
  const route:Point[]=[];for(let key=finish;key>=0;key=prev[key])route.push(point(Math.floor(key/3)));route.reverse();
  const points=[start,...route,end].filter((p,i,all)=>!i||p.x!==all[i-1].x||p.y!==all[i-1].y);
  // Only collinear simplification: every segment stays in a gutter channel.
  const simplified:Point[]=[];
  for(const p of points){
    while(simplified.length>1){const a=simplified.at(-2)!,b=simplified.at(-1)!;
      if((a.x===b.x&&b.x===p.x)||(a.y===b.y&&b.y===p.y))simplified.pop();else break;
    }simplified.push(p);
  }
  return simplified.map((p,i)=>`${i ? "L" : "M"} ${p.x} ${p.y}`).join(" ");
}
