import {notFound} from 'next/navigation';
import {commitLabel} from '@/lib/aegis/build';
import {RECORDED_EVIDENCE} from '@/lib/aegis/recorded-evidence';
import {RecordedEvidenceViewer} from '@/components/builder/RecordedEvidenceViewer';
export default async function RecordedEvidencePage({params,searchParams}:{params:Promise<{id:string}>;searchParams:Promise<{artifact?:string}>}) {
  const {id}=await params, query=await searchParams;
  const record=RECORDED_EVIDENCE.find(r=>r.pipelineId===id);
  if(!record || record.schema!=='ccm.application-evidence.v1') notFound();
  return <RecordedEvidenceViewer record={record} artifact={query.artifact} buildCommit={commitLabel()}/>;
}
