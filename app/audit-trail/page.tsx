import { AuditTrailScreen } from "@/components/m1/Frame23";
import { m1PageContext } from "@/lib/server/m1-page";
export const dynamic = "force-dynamic";
export default async function Page({ searchParams }: { searchParams: Promise<{ objectKey?: string; workspace?: string }> }) {
  const query = await searchParams;
  const context = await m1PageContext(query);
  return <AuditTrailScreen {...context} focus={/^[a-f0-9]{64}$/.test(query.objectKey ?? "") ? query.objectKey! : null}/>;
}
