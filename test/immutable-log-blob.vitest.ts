import { beforeEach, expect, it, vi } from "vitest";
const blobs = vi.hoisted(() => new Map<string, string>());
vi.mock("../lib/durable", () => ({
  persistenceMode: () => "blob",
  listBlobPathnames: async (prefix: string) => [...blobs.keys()]
    .filter(key => key.startsWith(prefix)).map(pathname => ({ pathname })),
  blobGetText: async (key: string) => blobs.get(key) ?? null,
  blobPutText: async (key: string, value: string) => {
    if (blobs.has(key)) throw new Error("Already exists");
    blobs.set(key, value);
  },
}));
import { appendLog, objectKeys, readLog } from "../lib/immutable-log";
beforeEach(() => blobs.clear());
it("Blob log enumeration matches local JSON-only enumeration beside retained ZIP bytes", async () => {
  const prefix = "aegis/connection-exports/synthetic/";
  blobs.set(prefix + "export.zip", "PK\u0003\u0004binary export bytes");
  await appendLog(prefix, { id: "export-one" }, body => body.id === "export-one");
  await appendLog(prefix, { id: "export-two" }, body => body.id === "export-two");
  expect(await objectKeys(prefix)).toHaveLength(2);
  expect((await readLog<{ id: string }>(prefix)).map(row => row.body.id))
    .toEqual(["export-one", "export-two"]);
  expect(blobs.get(prefix + "export.zip")).toBe("PK\u0003\u0004binary export bytes");
  const key = (await objectKeys(prefix))[0];
  blobs.set(key, JSON.stringify({ sequence: 0, prevHash: "0".repeat(64), hash: "0".repeat(64), body: { id: "changed" } }));
  await expect(readLog(prefix)).rejects.toThrow(/chain verification/);
});
