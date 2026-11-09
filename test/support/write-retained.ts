import { randomBytes } from "node:crypto";
import { addEvidenceFile, emptyPersisted, exportOscal, findRepoRoot, loadFixture } from "../../lib/aegis";
import { outDir, Session } from "../../lib/aegis/store";
import { flushRetainedWrites } from "../../lib/retained-bytes";

const root = findRepoRoot();
const id = randomBytes(16).toString("hex");
const session = Session.create(id, root);
const ctx = { ...session.ctx, outDir: outDir(root, id) };
let state = loadFixture(emptyPersisted(), "gold", ctx);
state = addEvidenceFile(state, "AU-2", {
  filename: "retention-note.txt",
  bytes: Buffer.from("retention sample bytes"),
  title: "Retention note",
  type: "Document",
}, ctx);
const exported = exportOscal(state, ctx);
await flushRetainedWrites();
session.commit(exported.state);
await session.flush();
process.stdout.write(`${id}\n`);
