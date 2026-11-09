"use client";
import { useEffect, useRef, useState } from "react";
export type WorkspaceView = "map" | "release" | "export" | "changes" | "connections" | "future";
const TABS: ReadonlyArray<[WorkspaceView, string]> = [["map", "Package map"], ["release", "Release evidence"], ["export", "Export flow"], ["changes", "Changes"], ["connections", "System connections"]];
export function WorkspaceNavigation({ view, disabled = false, onNavigate, onDeveloperDetails, onLoadExample, planning = true, exportLocked = false }: { view: WorkspaceView; disabled?: boolean; onNavigate?: (view: WorkspaceView) => void; onDeveloperDetails?: () => void; onLoadExample?: () => void; planning?: boolean; exportLocked?: boolean }) {
  const [open, setOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    function dismiss(event: PointerEvent) { if (!menu.current?.contains(event.target as Node)) setOpen(false); }
    function keyboard(event: KeyboardEvent) { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus(); } }
    document.addEventListener("pointerdown", dismiss); document.addEventListener("keydown", keyboard, true);
    return () => { document.removeEventListener("pointerdown", dismiss); document.removeEventListener("keydown", keyboard, true); };
  }, [open]);
  function choose(next: WorkspaceView) { setOpen(false); onNavigate?.(next); }
  return <nav className="nav chrome-nav workspace-navigation" aria-label="Workspace navigation" data-testid="workspace-navigation" data-current-view={view}>
    {TABS.map(([id, label]) => onNavigate && (planning || (id !== "release" && id !== "connections")) ? <button key={id} type="button" data-view={id} aria-current={view === id ? "page" : undefined} disabled={disabled} onClick={() => choose(id)}>{label}{id === "export" && exportLocked && <span className="nav-lock">locked</span>}</button> : <a key={id} data-view={id} aria-current={view === id ? "page" : undefined} href={`/planning?view=${id}`}>{label}</a>)}
    <div className="workspace-more" ref={menu}>
      <button ref={trigger} disabled={disabled} type="button" className="workspace-more-trigger" aria-expanded={open} aria-controls="workspace-more-options" aria-current={view === "future" ? "page" : undefined} onClick={() => setOpen(!open)}>More <span aria-hidden="true">▾</span></button>
      {open && <div id="workspace-more-options" className="workspace-more-options" aria-label="More workspace options">
        {onNavigate ? <button type="button" data-view="future" onClick={() => choose("future")}><strong>Future stubs <span className="pill miss">Stub</span></strong><small>Six placeholders · not wired</small></button> : <a href="/planning?view=future"><strong>Future stubs <span className="pill miss">Stub</span></strong><small>Six placeholders · not wired</small></a>}
        <a href={planning ? "/workspace?workspace=planning" : "/planning"} target="_blank" rel="noreferrer"><strong>{planning ? "Package workspace ↗" : "Control planning ↗"}</strong><small>{planning ? "Open the active planning workspace" : "Open control planning · separate package state"}</small></a>
        {onLoadExample ? <button type="button" aria-label="Load planning example" onClick={() => { setOpen(false); onLoadExample(); }}><strong>Load planning example</strong><small>Demo sample package</small></button> : null}
        {onDeveloperDetails ? <button type="button" onClick={() => { setOpen(false); onDeveloperDetails(); }}><strong>Developer details</strong><small>Demo sample · CSV control table · CLI peer</small></button> : <a href="/planning?details=developer"><strong>Developer details</strong><small>Demo sample · CSV control table · CLI peer</small></a>}
      </div>}
    </div>
  </nav>;
}
