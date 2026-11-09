import {CCM_EXAMPLE as historical} from "../../lib/aegis/pipeline-evidence";
import capture from "../../lib/reference/podinfo-source.json" with {type:"json"};
import {readCollectedArtifact} from "../../lib/collector/read";
export const CCM_EXAMPLE={...historical,collectedArtifacts:capture.artifacts.map(readCollectedArtifact).filter(a=>a!==null)};
