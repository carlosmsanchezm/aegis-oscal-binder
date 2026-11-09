import { ObservationViewer } from "@/components/builder/ObservationViewer";
import { m1PageContext } from "@/lib/server/m1-page";
export const dynamic = "force-dynamic";
export default async function EvidencePage({ params, searchParams }: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ connection?: string; artifact?: string; check?: string }>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const context = await m1PageContext({ workspace: "sa1-demo" });
  return <ObservationViewer {...context} id={id} connection={query.connection ?? ""} artifactName={query.artifact} checkId={query.check}/>;
}
