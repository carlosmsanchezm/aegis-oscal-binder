import type {CollectedArtifact} from './types';
/** Only validated source metadata forms outbound links; never infer a system's repo. */
export function sourceCommitLink(source: {repo?: string; commit?: string; kind?: string}){
 try{
  if (!source.repo || !source.commit || source.kind === "aws-account") return null;
  const url=new URL(source.repo);
  if(url.protocol!=='https:' || url.username || url.password || url.search || url.hash || !/^[a-f0-9]{40,64}$/.test(source.commit))return null;
  const path=url.pathname.replace(/\/$/,'').replace(/\.git$/,'');
  const name=path.replace(/^\//,'') || url.host;
  const href=url.hostname==='github.com' ? `${url.origin}${path}/tree/${source.commit}`
   : url.hostname==='gitlab.com' ? `${url.origin}${path}/-/tree/${source.commit}`
   : url.hostname==='bitbucket.org' ? `${url.origin}${path}/src/${source.commit}` : url.toString();
  return {name,href,commit:source.commit};
 }catch{return null;}
}

export function sourceRepositories(artifacts:Iterable<CollectedArtifact>):{repo: string; commit: string}[]{
 const pins = [...artifacts].flatMap(({source}) => source.kind === "aws-account" ? [] : [{repo: source.repo, commit: source.commit}]);
 return [...new Map(pins.map((source)=>[JSON.stringify([source.repo,source.commit]), source])).values()]
  .sort((a,b)=>a.repo.localeCompare(b.repo) || a.commit.localeCompare(b.commit));
}
