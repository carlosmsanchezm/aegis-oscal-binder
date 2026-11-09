import React from "react";
import {it,expect,vi} from "vitest";
import {renderHook,act} from "@testing-library/react";
import {useConnectedEvidence} from "../../components/binder/useConnectedEvidence";

const response=(connections:unknown[]=[])=>({ok:true,json:async()=>({ok:true,connections,refreshIntervalMs:3000})}) as Response;
it("a slow connected poll is not aborted or overlapped by periodic refresh",async()=>{
  vi.useFakeTimers();sessionStorage.clear();
  vi.spyOn(document,"visibilityState","get").mockReturnValue("visible");
  let finish!:(value:Response)=>void,signal!:AbortSignal;
  const fetch=vi.fn().mockResolvedValueOnce(response()).mockImplementation((_url,init)=>{
    signal=init.signal;return new Promise<Response>(resolve=>{finish=resolve;});
  });vi.stubGlobal("fetch",fetch);
  const hook=renderHook(()=>useConnectedEvidence());
  try{
    await act(async()=>{await Promise.resolve();});
    await act(async()=>{await vi.advanceTimersByTimeAsync(3000);});
    expect(fetch).toHaveBeenCalledTimes(2);
    await act(async()=>{await vi.advanceTimersByTimeAsync(9000);});
    expect(fetch).toHaveBeenCalledTimes(2);expect(signal.aborted).toBe(false);
    await act(async()=>{finish(response([{id:"current",name:"Current",history:[]}]));});
    expect(hook.result.current.connections[0]?.id).toBe("current");
  }finally{hook.unmount();vi.useRealTimers();}
});
it("a selection change discards the in-flight view and a later poll reads the new selection",async()=>{
  vi.useFakeTimers();sessionStorage.clear();
  vi.spyOn(document,"visibilityState","get").mockReturnValue("visible");
  let finish!:(value:Response)=>void;
  const fetch=vi.fn().mockResolvedValueOnce(response()).mockImplementationOnce(()=>new Promise<Response>(resolve=>{finish=resolve;}))
    .mockResolvedValue(response([{id:"current",name:"Current",history:[]}]));vi.stubGlobal("fetch",fetch);
  const hook=renderHook(()=>useConnectedEvidence());
  try{
    await act(async()=>{await Promise.resolve();});
    await act(async()=>{await vi.advanceTimersByTimeAsync(3000);});
    act(()=>hook.result.current.select("current"));
    await act(async()=>{finish(response([{id:"old",name:"Old",history:[]}]));});
    expect(hook.result.current.connections).toEqual([]);
    await act(async()=>{await vi.advanceTimersByTimeAsync(3000);});
    expect(hook.result.current.selectedId).toBe("current");expect(hook.result.current.connections[0]?.id).toBe("current");
  }finally{hook.unmount();vi.useRealTimers();}
});
it("effect cleanup aborts the old read without blocking the replacement mount",async()=>{
  sessionStorage.clear();const signals:AbortSignal[]=[];
  vi.stubGlobal("fetch",vi.fn((_url,init)=>{signals.push(init.signal);return Promise.resolve(response());}));
  const hook=renderHook(()=>useConnectedEvidence(),{wrapper:React.StrictMode});
  try{
    await act(async()=>{await Promise.resolve();});
    expect(signals).toHaveLength(2);expect(signals[0].aborted).toBe(true);expect(signals[1].aborted).toBe(false);
    expect(hook.result.current.loading).toBe(false);
  }finally{hook.unmount();}
});
