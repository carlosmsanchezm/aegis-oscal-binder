import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { frame22State, frame25Counts, frame25State, regenerateRequest, type Stored, type Result } from "../lib/m1/state";
import { regenerateHref, toStored, toResult, m1Href } from "../lib/m1/api";
import { shortDigest, receiptDigest, exportDigest, exportFileLabel } from "../lib/m1/format";
import { excerptTokens, excerptText } from "../lib/m1/json-excerpt";
import { shortCommit } from "../lib/aegis/build";
import after from "../lib/reference/online-boutique-after.json" with { type: "json" };

const digest = "1234567890abcdef".repeat(4);
const object: Stored = toStored({ objectKey: "a".repeat(64), objectName: "file.xml", kind: "export", recordedDigest: digest, storedAt: "2026-10-06T18:39:19Z", exportId: "exp-0001", render: "oscal" });
const result = (status: Result["status"]): Result => toResult({ ...object, exportId: object.exportId ?? undefined, result: status, recomputedDigest: status === "unreadable" ? null : digest });

test("M1 source files are ASCII, including all copy, cards and the retained viewer", () => {
  for (const dir of ["components/m1", "lib/m1"]) for (const name of readdirSync(dir)) {
    const bytes = readFileSync(`${dir}/${name}`);
    assert.ok(bytes.every(byte => byte <= 127), `${dir}/${name}`);
  }
});
test("digest forms and deployment label never invent values", () => {
  assert.equal(receiptDigest(digest), `${digest.slice(0,20)}\u2026${digest.slice(-7)}`);
  assert.equal(shortDigest(digest), `${digest.slice(0,8)}\u2026${digest.slice(-7)}`);
  assert.equal(exportDigest(digest), digest.slice(0,6));
  assert.equal(shortCommit("not-a-sha"), "unknown");
  assert.equal(shortCommit("94db668"), "94db668");
  assert.equal(shortCommit(""), "unknown");
});
test("mismatch wins over matching results and unverified bytes cannot make an all match pass", () => {
  assert.equal(frame22State({ objects:[object], results:{[object.objectKey]:result("mismatch")}, focus:null, failed:false }).kind, "export-mismatch");
  assert.equal(frame25State({ objects:[object], check:{ checkedAt:"2026-10-06T18:39:19Z", results:[result("unverified")] }, progress:null, failed:false }).kind,"results");
  assert.deepEqual(frame25Counts([result("match"), result("mismatch"), result("unreadable"), result("unverified")]), {checked:2,match:1,mismatch:1,unreadable:1,unverified:1});
  assert.equal(regenerateRequest({...object,kind:"evidence"}), null);
  assert.equal(regenerateRequest({...object,current:false}), null);
  assert.equal(m1Href("planning","/stored/audit",{object:object.objectKey}), `/audit-trail?objectKey=${object.objectKey}&workspace=sa1-demo`);
});
test("word and excel rows use the locked frame names and the regenerate link keeps the stored object", () => {
  assert.equal(exportFileLabel("exp-0001-package-oscal.xml", "exp-0001"), "package-oscal.xml");
  assert.equal(exportFileLabel("package.docx", "exp-0001"), "ssp-readable.docx");
  assert.equal(exportFileLabel("package.xlsx", "exp-0001"), "control-table.xlsx");
  assert.equal(exportFileLabel("package.v2.docx", "exp-0001"), "ssp-readable.v2.docx");
  const word = toStored({ objectKey: "b".repeat(64), objectName: "package.docx", kind: "export", recordedDigest: digest, storedAt: "2026-10-06T18:39:19Z", exportId: "exp-0001", render: "word" });
  assert.equal(regenerateHref("classic", word), `/regenerate-export?objectKey=${word.objectKey}&exportId=exp-0001&render=word`);
  assert.equal(regenerateHref("planning", word), `/regenerate-export?objectKey=${word.objectKey}&exportId=exp-0001&render=word&workspace=sa1-demo`);
});
test("the retained JSON excerpt folds the real captured artifact without losing its content", () => {
  const artifact = JSON.parse(after.rawEvent).artifacts.find((item: {name:string}) => item.name === "authorization-review.json");
  const value = JSON.parse(Buffer.from(artifact.contentBase64,"base64").toString());
  const tokens = excerptTokens(value);
  const fold = tokens.find(item => item.kind === "fold");
  assert.ok(fold && fold.kind === "fold");
  assert.equal(fold.count,4);
  assert.deepEqual(JSON.parse(excerptText(excerptTokens(value,new Set([fold.path])))),value);
});
