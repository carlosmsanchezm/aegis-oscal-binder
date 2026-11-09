import React from "react";
import {sourceCommitLink} from '@/lib/collector/source-link';
import type {CollectedArtifact} from '@/lib/collector/types';
import {SYSTEM_SOURCES} from '@/lib/aegis/ui-copy';
export function SourceRepo({source}:{source:Pick<CollectedArtifact['source'],'repo'|'commit'>}){
 const link=sourceCommitLink(source);
 return link ? <a data-testid="source-repo" href={link.href} title={`${source.repo} at ${source.commit}`} target="_blank" rel="noopener noreferrer">{link.name} at {link.commit.slice(0,7)} ↗</a> : null;
}

/** Repository context is separate from a captured measurement's own provenance. */
export function SystemSources({sources,stacked=false}:{sources?:Pick<CollectedArtifact['source'],'repo'|'commit'>[];stacked?:boolean}){
 if(!sources?.length) return null;
 // Stacked: one source per line for narrow side panels.
 if(stacked) return <span className="system-sources-stack"><span>{SYSTEM_SOURCES.label}</span>{sources.map(source=><SourceRepo key={`${source.repo}:${source.commit}`} source={source}/>)}<span>{SYSTEM_SOURCES.note}</span></span>;
 return <span>{SYSTEM_SOURCES.label} {sources.map((source,i)=><React.Fragment key={`${source.repo}:${source.commit}`}>{i>0 && ' · '}<SourceRepo source={source}/></React.Fragment>)} · {SYSTEM_SOURCES.note}</span>;
}
