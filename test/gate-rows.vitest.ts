import {it,expect} from "vitest";
import {gateVerdict,GATE_WHAT} from "../lib/aegis/gate-rows";
it("separates reported verdict from freshness",()=>{expect(gateVerdict({id:"sast",status:"stale",reportedVerdict:"fail",findings:4,blockingCount:1,artifact:"sast.json"})).toBe("Blocks release");expect(gateVerdict({id:"sast",status:"unknown",findings:null,blockingCount:null,artifact:"sast.json"})).toBe("Result unavailable");expect(GATE_WHAT.configuration).toBe("Kubernetes manifests");});
