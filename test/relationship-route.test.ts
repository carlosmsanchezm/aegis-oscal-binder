import {test} from 'node:test';
import assert from 'node:assert/strict';
import {relationshipRoute} from '../lib/aegis/relationship-route';
test('channel routing uses orthogonal segments and avoids the full obstacle interior',()=>{
 const box={x:40,y:8,w:40,h:32};
 const d=relationshipRoute({x:20,y:20},{x:100,y:20},[box],120,0,1,1,64);
 assert.ok(d);assert.doesNotMatch(d,/[CQ]/);
 const values=d.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
 for(let i=2;i<values.length;i+=2){const a={x:values[i-2],y:values[i-1]},b={x:values[i],y:values[i+1]};
  assert.ok(a.x===b.x || a.y===b.y);
  const hit=a.x===b.x ? a.x>box.x&&a.x<box.x+box.w&&Math.max(a.y,b.y)>box.y&&Math.min(a.y,b.y)<box.y+box.h : a.y>box.y&&a.y<box.y+box.h&&Math.max(a.x,b.x)>box.x&&Math.min(a.x,b.x)<box.x+box.w;
  assert.equal(hit,false);
 }
});
test('review-map channels keep an eight-pixel clearance around obstacles',()=>{
 const box={x:40,y:8,w:40,h:32};
 const d=relationshipRoute({x:20,y:20},{x:100,y:20},[box],120,0,1,1,64,8);
 assert.ok(d);const values=d.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
 for(let i=2;i<values.length;i+=2){const a={x:values[i-2],y:values[i-1]},b={x:values[i],y:values[i+1]};
  for(let step=0;step<=100;step++){const x=a.x+(b.x-a.x)*step/100,y=a.y+(b.y-a.y)*step/100;assert.equal(x>=box.x-6&&x<=box.x+box.w+6&&y>=box.y-6&&y<=box.y+box.h+6,false);}
 }
});
