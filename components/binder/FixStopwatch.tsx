"use client";
import React, {useEffect,useState} from "react";
import type {FixProgress} from "@/lib/aegis/fix-progress";
export function FixStopwatch({progress}:{progress:FixProgress|null}) {
  const [now,setNow]=useState(Date.now());
  useEffect(()=>{
    if (!progress || progress.finishedAt) return;
    setNow(Date.now());
    const timer=setInterval(()=>setNow(Date.now()),1000);
    return ()=>clearInterval(timer);
  },[progress?.startedAt,progress?.finishedAt]);
  if (!progress) return null;
  const elapsed=Math.max(0,Math.floor(((progress.finishedAt?Date.parse(progress.finishedAt):now)-Date.parse(progress.startedAt))/1000));
  const time=`${Math.floor(elapsed/60).toString().padStart(2,"0")}:${(elapsed%60).toString().padStart(2,"0")}`;
  return <div className="chip" data-testid="fix-stopwatch" title="Time from fan-out to collected release verification. Human closure remains required."><span>{progress.finishedAt?"Review ready":"Fix time"}</span><span role="timer" aria-label="Elapsed remediation time"><strong>{time}</strong></span><span>{progress.verified}/{progress.total} verified</span></div>;
}
