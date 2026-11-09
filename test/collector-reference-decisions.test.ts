import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { referenceInventory } from "../lib/collector/reference-inventory";
import {
  CCM_EXAMPLE,
  controlsForArtifact,
} from "../lib/aegis/pipeline-evidence";
import { RECORDED_EVIDENCE } from "../lib/aegis/recorded-evidence";
import { moderateControls } from "../lib/aegis/moderate-baseline";
import {
  proposeArtifactMappings,
  applyAcceptedArtifactMappings,
  reviewedArtifactDecision,
} from "../lib/aegis/artifact-mapping";
import { Session, runWithSession } from "../lib/aegis/store";
import { emptyPersisted } from "../lib/aegis/operations";
import { postPipelineMapping } from "../lib/server/handlers";

for (const record of RECORDED_EVIDENCE)
  test(`source facts on frozen receipt ${record.pipelineId} can be dismissed and accepted without changing its seal`, async () => {
    const previous = process.env.AEGIS_DATA_DIR,
      root = mkdtempSync(path.join(tmpdir(), "collector-reference-decision-"));
    process.env.AEGIS_DATA_DIR = root;
    try {
      const source = referenceInventory(record),
        ids = moderateControls().map((control) => control.id);
      const file = source.collectedArtifacts!.find(
        (file) => file.source.path === "Dockerfile",
      )!;
      const proposal = proposeArtifactMappings(source, ids).find(
        (proposal) => proposal.artifact === file.name,
      )!;
      assert(
        proposal.candidates.some((candidate) => candidate.controlId === "CM-6"),
      );
      const session = Session.create("72".repeat(16), root);
      await runWithSession(session, async () => {
        session.commit({ ...emptyPersisted(), catalogId: "fedramp-rev5" });
        for (const status of ["rejected", "accepted"] as const) {
          const response = await postPipelineMapping({
            scope: "catalog",
            proposalKey: proposal.key,
            profile: proposal.profile,
            status,
            controls: ["CM-6"],
            reviewer: "Synthetic reference reviewer",
          });
          assert.equal(response.status, 200);
          const saved = (await response.json()).decision;
          assert.equal(
            reviewedArtifactDecision(source, [saved], proposal)?.status,
            status,
          );
          const mapped = applyAcceptedArtifactMappings(source, [saved]);
          assert.equal(mapped.releaseSha256, record.releaseSha256);
          assert.deepEqual(mapped.checks, record.checks);
          assert.deepEqual(
            controlsForArtifact(mapped, file.name),
            status === "accepted" ? ["CM-6"] : [],
          );
        }
      });
    } finally {
      if (previous === undefined) delete process.env.AEGIS_DATA_DIR;
      else process.env.AEGIS_DATA_DIR = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });

test("public inventory hydration requires every frozen identity field and never trusts caller source facts", () => {
  const forged = { ...CCM_EXAMPLE, releaseSha256: "0".repeat(64) };
  assert.equal(referenceInventory(forged), forged);
  const hydrated = referenceInventory({
    ...CCM_EXAMPLE,
    collectedArtifacts: [],
  });
  assert((hydrated.collectedArtifacts?.length ?? 0) > 0);
  assert.equal(CCM_EXAMPLE.collectedArtifacts, undefined);
});
