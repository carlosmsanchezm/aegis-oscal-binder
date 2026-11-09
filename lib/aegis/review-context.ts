/** Reviewer-selected scope. These references do not establish compliance. */
export type ReviewScope = {
  fixPaths?: string[]; resourceIds?: string[];
  title: string; asset: string; controls: string[]; framework: string; baseline: string;
  artifacts: string[]; verification: string[]; remainingScope: string[];
};
export type ReviewObservation = { id: string; description: string; scope: ReviewScope; mappingStatus?: "proposed"; retestPacketUrl?: string };
export const blankReviewScope = (): ReviewScope => ({ title: "", asset: "", controls: [], framework: "", baseline: "", artifacts: [], verification: [], remainingScope: [] });
export function scopeProblems(scope?: ReviewScope): string[] {
  if (!scope) return ["Define the assessment scope."];
  return [!scope.title.trim() && "Name the scoped finding.", !scope.asset.trim() && "Identify the affected asset.",
    (!scope.controls.length || scope.controls.some(id => !/^[a-z][a-z0-9_.-]{0,79}$/i.test(id))) && "Select valid control references.",
    !scope.framework.trim() && "Identify the framework.", !scope.baseline.trim() && "Identify the policy or baseline reference.",
    !scope.artifacts.length && "Select the source artifacts.",
    (!scope.verification.length || scope.verification.some(test => !test.trim())) && "Define the required verification tests."].filter(Boolean) as string[];
}
export function parseReviewScope(value: unknown): ReviewScope {
  if (!value || typeof value !== "object") throw new Error("Invalid review scope.");
  const s = value as Record<string, unknown>;
  const str = (key: string) => { const v=s[key]; if (typeof v!=="string" || v.length>12000) throw new Error(`Invalid scope ${key}.`); return v; };
  const list = (key: string, max=30) => { const v=s[key]; if (!Array.isArray(v) || v.length>max || v.some(x=>typeof x!=="string" || x.length>1000)) throw new Error(`Invalid scope ${key}.`); return v as string[]; };
  return { ...(s.fixPaths === undefined ? {} : {fixPaths:list("fixPaths",100)}), ...(s.resourceIds === undefined ? {} : {resourceIds:list("resourceIds",100)}), title:str("title"), asset:str("asset"), framework:str("framework"), baseline:str("baseline"), controls:list("controls"), artifacts:list("artifacts",40), verification:list("verification"), remainingScope:list("remainingScope") };
}
/** Explicit example template only; never selected by the assessment engine. */
export const NETWORK_POLICY_EXAMPLE_SCOPE: ReviewScope = {
  title:"Network-policy enforcement needs corrective action", asset:"podinfo namespace", controls:["SC-7"],
  framework:"NIST SP 800-53 Rev 5", baseline:"Illustrative system requirement · selected controls only",
  artifacts:["runtime.json","configuration.json"], verification:["NetworkPolicy applied in the podinfo namespace","Cross-namespace traffic denied","Allowed traffic limited to the gateway path"],
  remainingScope:["Ingress","mTLS"],
};


/** Bounded, explicitly scoped finding records supplied by a release producer. */
export function parseReviewObservations(value: unknown, artifacts: string[]): ReviewObservation[] {
  if (!Array.isArray(value) || value.length > 50) throw new Error("Invalid review items.");
  const inventory = new Set(artifacts);
  const records = value.map(raw => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid review observation.");
    const item = raw as Record<string, unknown>;
    const field = (key: string, max: number) => {
      const v = item[key];
      if (typeof v !== "string" || !v.trim() || v.length > max || /[\u0000-\u001f]/.test(v)) throw new Error(`Invalid review ${key}.`);
      return v.trim();
    };
    const id = field("id", 80);
    if (!/^[A-Za-z0-9_.-]+$/.test(id)) throw new Error("Invalid review identifier.");
    const scope = parseReviewScope(item.scope);
    if (scopeProblems(scope).length) throw new Error("Invalid review scope.");
    if (scope.artifacts.some(name => !/^[A-Za-z0-9_.-]{1,80}$/.test(name) || name.includes("..") || !inventory.has(name))) throw new Error("Invalid review artifact outside the source artifact inventory.");
    const packet = item.retestPacketUrl;
    if (packet != null && (typeof packet !== "string" || !/^\/samples\/remediation\/[a-z0-9-]+\.json$/.test(packet))) throw new Error("Invalid local retest template link.");
    return { id, description: field("description", 12000), scope, ...(packet ? { retestPacketUrl: packet as string } : {}) };
  });
  if (new Set(records.map(item => item.id)).size !== records.length) throw new Error("Duplicate review identifiers.");
  return records;
}
