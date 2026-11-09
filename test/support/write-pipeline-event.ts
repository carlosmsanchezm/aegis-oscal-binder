import { POST } from "../../app/api/pipeline/events/route";
import { createHmac } from "node:crypto";

const body = process.env.EVENT_BODY ?? "";
const secret = process.env.AEGIS_PIPELINE_WEBHOOK_SECRET ?? "";
const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
const response = await POST(new Request("http://127.0.0.1/api/pipeline/events", {
  method: "POST",
  headers: { "content-type": "application/json", "x-aegis-signature": signature },
  body,
}));
if (response.status !== 200) {
  process.stderr.write(`pipeline write failed with status ${response.status}\n`);
  process.exit(1);
}
process.exit(0);
