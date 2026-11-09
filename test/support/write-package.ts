import { POST as selectCatalog } from "../../app/api/catalogs/select/route";
import { POST as loadFixture } from "../../app/api/fixtures/load/route";

function sessionId(response: Response): string | null {
  const match = /aegis_sid=([a-f0-9]{32})/.exec(response.headers.getSetCookie().join("\n"));
  return match?.[1] ?? null;
}

const selected = await selectCatalog(new Request("http://127.0.0.1/api/catalogs/select", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ catalog: "fedramp-rev5" }),
}));
const id = sessionId(selected);
if (selected.status !== 200 || !id) {
  process.stderr.write(`catalog select failed with status ${selected.status}\n`);
  process.exit(1);
}
const loaded = await loadFixture(new Request("http://127.0.0.1/api/fixtures/load", {
  method: "POST",
  headers: { "content-type": "application/json", cookie: `aegis_sid=${id}` },
  body: JSON.stringify({ fixture: "gold" }),
}));
if (loaded.status !== 200) {
  process.stderr.write(`package write failed with status ${loaded.status}\n`);
  process.exit(1);
}
process.stdout.write(`${id}\n`);
