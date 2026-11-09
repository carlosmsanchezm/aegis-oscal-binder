"use client";
import React from "react";
import { SourceRepo, SystemSources } from "../binder/SourceRepo";
import { sourceRepositories } from "@/lib/collector/source-link";
import { readCollectedArtifact } from "@/lib/collector/read";
import { useConnectedEvidence } from "../binder/useConnectedEvidence";
import { Frame19Screen, artifactContent, useFrame19Controls, useRetainedBundle } from "../m1/Frame19";
import type { M1Header } from "../m1/M1Chrome";
import type { Workspace } from "@/lib/m1/api";

export function ObservationViewer({ id, connection, artifactName, checkId, header, workspace, buildSha }: {
  id: string; connection: string; artifactName?: string; checkId?: string;
  header: M1Header; workspace: Workspace; buildSha: string;
}) {
  const store = useConnectedEvidence();
  const system = store.connections.find(item => item.id === connection);
  const download = `/api/builder/evidence/${encodeURIComponent(id)}?${new URLSearchParams({ connection })}`;
  const { load, selected, setSelected } = useRetainedBundle(download, artifactName, checkId);
  const controls = useFrame19Controls();
  const artifact = load.kind === "ready" ? load.bundle.event.artifacts.find(item => item.name === selected) : undefined;
  const content = artifact ? artifactContent(artifact) : null;
  const collected = content?.kind === "json" && artifact?.mediaType === "application/json" ? readCollectedArtifact(content.value) : null;
  const repositories = sourceRepositories(system?.history.flatMap(receipt => receipt.collectedArtifacts ?? []) ?? []);
  const source = collected ? <>Source: <SourceRepo source={collected.source}/> {"\u00b7"} {collected.source.path}</> : repositories.length ? <SystemSources sources={repositories}/> : undefined;
  return <Frame19Screen header={header} workspace={workspace} buildSha={buildSha} receipt={id} download={download} load={load} now={controls.now}
    checkId={checkId} selected={selected} expanded={controls.expanded} limitationsOpen={controls.limitationsOpen} popover={controls.popover} copied={controls.copied} source={source}
    onSelect={name => { setSelected(name); controls.setExpanded(new Set()); }} onExpand={controls.onExpand}
    onToggleLimitations={() => controls.setLimitationsOpen(!controls.limitationsOpen)} onPopover={controls.setPopover}
    onCopy={(value, label) => void controls.onCopy(value, label)}/>;
}
