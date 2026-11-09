"use client";
import React, { useState } from "react";
import "./m1.css";
import { CARET, CHROME, DOT, HONESTY } from "@/lib/m1/copy";
import { workspaceViewHref, type Workspace } from "@/lib/m1/api";

export type M1Header = {
  workspaceName: string;
  catalog: string;
  pin: string | null;
  gate: { status: "EMPTY" | "FAIL" | "PASS"; incomplete: number; total: number };
} | null;

export type M1Tab = "map" | "release" | "export" | "changes" | "connections";
const TAB_IDS: M1Tab[] = ["map", "release", "export", "changes", "connections"];

export function M1Chrome({ header, tab, workspace, buildSha, children, testId }: {
  header: M1Header;
  tab: M1Tab;
  workspace: Workspace;
  buildSha: string;
  children: React.ReactNode;
  testId?: string;
}) {
  const [handling, setHandling] = useState(false);
  return <div className="m1" data-testid={testId}>
    <header className="m1-head">
      <div className="m1-topbar">
        <div className="m1-mark" aria-hidden="true"><span /></div>
        <div className="m1-brand">{CHROME.product}</div>
        <div className="m1-org" aria-label={CHROME.orgLabel}><span className="m1-org-mark" aria-hidden="true">{CHROME.orgInitials}</span><b>{CHROME.org}</b><span className="m1-org-sep" aria-hidden="true">/</span></div>
        <div className="m1-chip m1-chip-workspace"><span className="m1-muted">{CHROME.workspace}</span><b data-testid="m1-workspace" title={header?.workspaceName}>{header?.workspaceName ?? "No package loaded"}</b><span className="m1-caret" aria-hidden="true">{CARET}</span></div>
        {header && <div className="m1-chip"><span className="m1-muted">{CHROME.catalog}</span><b>{header.catalog}</b></div>}
        {header?.pin && <div className="m1-chip"><span className="m1-muted">{CHROME.pin}</span><span className="m1-pin">{header.pin}</span><span className="m1-chip-note">{CHROME.readOnly}</span></div>}
        <div className="m1-head-gap" />
        {header && <div className="m1-lamp" data-testid="m1-completeness"><span className="m1-muted">{CHROME.completeness}</span><span className={`m1-pill ${header.gate.status === "PASS" ? "ok" : "bad"}`}>{header.gate.status}</span><b>{header.gate.incomplete} of {header.gate.total} incomplete</b></div>}
        <div className="m1-user" aria-label={CHROME.avatarLabel}><span className="m1-avatar" aria-hidden="true">{CHROME.avatar}</span><span className="m1-user-caret" aria-hidden="true">{CARET}</span></div>
      </div>
      <nav className="m1-nav" aria-label="Workspace navigation">
        {CHROME.tabs.map((label, index) => {
          const id = TAB_IDS[index] as M1Tab;
          return <a key={id} href={workspaceViewHref(workspace, id)} aria-current={id === tab ? "page" : undefined}>{label}</a>;
        })}
        <span className="m1-spacer" />
        <a className="m1-more" href={workspaceViewHref(workspace, "future")}>{CHROME.more}<span aria-hidden="true">{CARET}</span></a>
      </nav>
    </header>
    {children}
    <footer className="m1-foot" data-testid="m1-footer">
      <b className="m1-foot-product">{CHROME.footerProduct}</b>
      <span>{CHROME.version}</span>
      <span className="m1-foot-version">{CHROME.versionValue}</span>
      <span className="m1-muted">{DOT}</span>
      <span className="m1-foot-build" data-testid="m1-build">{CHROME.build} {buildSha}</span>
      <span className="m1-spacer" />
      <span>{CHROME.notAuthorized}</span>
      <span className="m1-muted">{DOT}</span>
      <button type="button" className="m1-foot-handling" aria-expanded={handling} onClick={() => setHandling(!handling)}>{CHROME.dataHandling}</button>
      {handling && <div className="m1-handling" role="dialog" aria-label={CHROME.dataHandling}><p>{CHROME.dataHandlingBody}</p><p className="m1-honesty-card">{HONESTY}</p></div>}
    </footer>
  </div>;
}

export function TitleBlock({ title, chip, subtitle }: { title: string; chip: string; subtitle: string }) {
  return <div className="m1-titleblock">
    <div className="m1-row"><h1 className="m1-title">{title}</h1><span className="m1-sample">{chip}</span></div>
    <span className="m1-subtitle">{subtitle}</span>
    <span className="m1-honesty-title" data-testid="m1-honesty">{HONESTY}</span>
  </div>;
}

export function StateCard({ children, wide = false, name }: { children: React.ReactNode; wide?: boolean; name: string }) {
  return <section className={`m1-state${wide ? " wide" : ""}`} data-testid="m1-state-card" data-state={name}>
    <div className="m1-inner">{children}</div>
    <span className="m1-honesty-card" data-testid="m1-honesty">{HONESTY}</span>
  </section>;
}

export function SideHonesty() {
  return <span className="m1-honesty-side" data-testid="m1-honesty">{HONESTY}</span>;
}

export function Chip({ children }: { children: React.ReactNode }) {
  return <span className="m1-sample">{children}</span>;
}
