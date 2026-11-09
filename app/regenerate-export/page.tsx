import { RegenerateScreen } from "@/components/m1/Frame24";
import { m1PageContext } from "@/lib/server/m1-page";
export const dynamic = "force-dynamic";
export default async function Page({ searchParams }: { searchParams: Promise<{ objectKey?: string; workspace?: string; exportId?: string; render?: string }> }) {
  const query = await searchParams;
  const context = await m1PageContext(query);
  return <RegenerateScreen {...context} focus={query.objectKey ?? null} exportId={query.exportId ?? null} render={query.render ?? null}/>;
}
