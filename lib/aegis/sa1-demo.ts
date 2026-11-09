import sample from "../../public/samples/sample-oscal-ssp-rev5.json";

export const SA1_COOKIE = "aegis_sa1_sid";
export const SA1_HEADERS = { "x-aegis-workspace": "sa1-demo" };
export function sa1Api(path: string): string { return path.replace(/^\/api\//, "/api/demo/sa1/"); }
export const SA1_EVIDENCE = {
  title: "Synthetic event-logging standard",
  type: "Document",
  href: "https://example.com/synthetic/event-logging-standard",
};

/** Independent fixture: never alter the existing upload sample. */
export function sa1Document(): string {
  const doc = structuredClone(sample);
  const ssp = doc["system-security-plan"];
  ssp.metadata.title = "Synthetic service boundary";
  ssp.metadata.remarks = "Synthetic internal planning demonstration. Twelve-control subset; not an agency SSP, assessment, or authorization.";
  ssp["system-characteristics"]["system-name"] = ssp.metadata.title;
  ssp["system-characteristics"]["authorization-boundary"].description = "Synthetic application, shared identity service, and platform boundary. No agency evidence.";
  ssp.metadata.roles.push({ id: "isse", title: "Information System Security Engineer", "short-name": "ISSE" });
  ssp["system-implementation"].users.push({ uuid: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa06", title: "Information System Security Engineer", "role-ids": ["isse"] });
  const boundary = ssp["control-implementation"]["implemented-requirements"].find((r) => r["control-id"] === "sc-7");
  boundary?.["responsible-roles"]?.push({ "role-id": "isse" });
  const logging = ssp["control-implementation"]["implemented-requirements"].find((r) => r["control-id"] === "au-2");
  if (logging) {
    const narrative = "Security Operations routes selected application events to the SIEM; the ISSO reviews logging scope.";
    Object.assign(logging, { description: narrative });
    for (const component of logging["by-components"] ?? []) {
      component.description = narrative;
    }
    logging["responsible-roles"] = [{ "role-id": "secops" }, { "role-id": "isso" }];
  }
  return JSON.stringify(doc);
}

export const SA1_RESPONSIBILITY: Record<string, { kind: string; note: string }> = {
  "AC-2": { kind: "Shared", note: "Identity service manages accounts; application owners approve access and review accounts." },
  "AC-3": { kind: "Application", note: "Application owners define and enforce authorization rules." },
  "AC-6": { kind: "Shared", note: "Platform and application owners each document least-privilege access." },
  "IA-2": { kind: "Shared", note: "Identity provider handles authentication; application owners verify integration and coverage." },
  "IA-5": { kind: "Shared", note: "Provider manages authenticators; application owners protect application credentials." },
  "AU-2": { kind: "Application + shared service", note: "Security Operations selects logging events; the ISSO reviews scope." },
  "AU-6": { kind: "Shared", note: "SIEM supports analysis; system owners define review, escalation, and retention." },
  "CM-2": { kind: "Application", note: "ISSE designs the baseline; administrators maintain configuration and change records." },
  "CM-6": { kind: "Shared", note: "Verify platform coverage; application owners maintain application settings." },
  "SC-7": { kind: "Potential inheritance", note: "Verify provider boundary coverage; ISSE reviews application interconnections." },
  "SC-8": { kind: "Shared", note: "Provider and application owners document transport protection for each relevant path." },
  "SI-2": { kind: "Shared", note: "Provider patches infrastructure; application owners remediate dependencies." },
};

// Selected base-control membership in NIST's Rev5 baselines, NOT FedRAMP tailoring.
export const SA1_BASELINES = [
  { id: "AU-2", low: true, moderate: true, high: true },
  { id: "AU-6", low: true, moderate: true, high: true },
  { id: "AC-6", low: false, moderate: true, high: true },
  { id: "SC-8", low: false, moderate: true, high: true },
  { id: "AU-6(3)", low: false, moderate: true, high: true },
  { id: "AU-9(3)", low: false, moderate: false, high: true },
];
