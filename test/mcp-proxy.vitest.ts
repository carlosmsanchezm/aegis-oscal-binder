import {it,expect,vi} from "vitest";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {Server} from "@modelcontextprotocol/sdk/server/index.js";
import {InMemoryTransport} from "@modelcontextprotocol/sdk/inMemory.js";
import {CallToolRequestSchema} from "@modelcontextprotocol/sdk/types.js";
import {proxyToolCall} from "../lib/agent/mcp-proxy";

async function pair(handler:()=>Promise<{content:{type:"text";text:string}[];isError?:boolean}>){
 const [a,b]=InMemoryTransport.createLinkedPair(),server=new Server({name:"proxy-unit-server",version:"1"},{capabilities:{tools:{}}}),client=new Client({name:"proxy-unit-client",version:"1"});
 server.setRequestHandler(CallToolRequestSchema,handler);
 await server.connect(b);await client.connect(a);return {client,server};
}
it("retains a real SDK tool response after the default 60-second client deadline without retrying it",async()=>{
 let calls=0;const p=await pair(async()=>{calls++;return new Promise(resolve=>setTimeout(()=>resolve({content:[{type:"text",text:"unit operation completed"}],isError:true}),70_000));});
 vi.useFakeTimers();
 try{
  let settled=false;const result=proxyToolCall(p.client,{name:"slow-unit-tool",arguments:{}}).finally(()=>{settled=true;});
  await vi.advanceTimersByTimeAsync(60_001);expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(10_000);expect(await result).toEqual({content:[{type:"text",text:"unit operation completed"}],isError:true});expect(calls).toBe(1);
 }finally{vi.clearAllTimers();vi.useRealTimers();await p.client.close();await p.server.close();}
});
it("still times out an unresponsive tool at the hosted limit and does not replay the mutation",async()=>{
 let calls=0;const p=await pair(async()=>{calls++;return new Promise(()=>{});});vi.useFakeTimers();
 try{
  const result=proxyToolCall(p.client,{name:"stalled-unit-tool",arguments:{}}).then(()=>null,e=>e);
  await vi.advanceTimersByTimeAsync(300_001);expect((await result)?.message).toMatch(/timed out/i);expect(calls).toBe(1);
 }finally{vi.clearAllTimers();vi.useRealTimers();await p.client.close();await p.server.close();}
});
