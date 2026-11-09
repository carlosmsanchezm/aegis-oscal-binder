// Labeled test recordings from real Boutique Actions runs. Never production defaults.
import {createHash} from "node:crypto";
import original from "../fixtures/boutique-live/40446239616/event.json";
import retest from "../fixtures/boutique-live/40446815397/event.json";
import {parseEvidenceEvent} from "../lib/builder/evidence";
import {summarizeBuilderBundle} from "../lib/server/builder-observation";
import {connectedReleases} from "../lib/aegis/connected-evidence";
import {moderateRollupShell} from "../lib/aegis/rollup-shell";
import {applyReleaseRollup} from "../lib/aegis/rollup-package";
import {resultsMapPackage} from "../lib/aegis/results-map";
import {findRepoRoot} from "../lib/aegis/paths";
function recording(value:unknown){const event=parseEvidenceEvent(value),rawEvent=JSON.stringify(event);return summarizeBuilderBundle({schema:"aegis.evidence-bundle.v1",connectionId:"00000000-0000-0000-0000-000000000000",id:createHash("sha256").update(rawEvent).digest("hex"),rawEvent,event,receivedAt:event.run.observedAt,integrity:"verified",authentication:"browser-owner"});}
export const records=connectedReleases({id:"00000000-0000-0000-0000-000000000000",name:"Online Boutique",createdAt:original.run.observedAt,revokedAt:null,history:[recording(original),recording(retest)]},"https://binder.example",Date.parse(retest.run.observedAt)+60_000);
export const shell=moderateRollupShell(findRepoRoot());
export const pkg=applyReleaseRollup(shell,records);
import {evidenceByControl} from "../lib/collector/control-evidence";
export const proposalCounts=new Map(evidenceByControl(records,shell.controls.map(c=>c.id)).controls.map(c=>[c.id,c.suggested.length]));
export const map=resultsMapPackage(pkg,null,true,false,proposalCounts);
