import type { CATALOG_IDS, EVIDENCE_TYPES } from "./constants";

export type EvidenceType = (typeof EVIDENCE_TYPES)[number];
export type CatalogId = (typeof CATALOG_IDS)[number];
export type IngestKind = "gold" | "oscal" | "csv";
export type CatalogStatus = "live" | "stub";

export type Role = {
  id: string;
  title: string;
  /** OSCAL `short-name`. The map uses this when it is set. */
  shortName?: string;
};

/** By-statement SSP entry. Display only. It does not enter the completeness gate. */
export type ItemStatementRecord = {
  statementId: string;
  uuid: string;
  description: string;
  componentUuid: string;
  byComponentUuid: string;
  evidenceUuids: string[];
};

export type EvidenceRecord = {
  /** Receipt time of an uploaded file, omitted for links and older records. */
  storedAt?: string;
  id: string;
  title: string;
  type: EvidenceType;
  href: string;
  uuid: string;
  /** SHA 256 of uploaded file bytes. Omitted for links and packaged fixture files. */
  sha256?: string;
};

export type ControlRecord = {
  /** Explicit imported map display metadata; excluded from completeness decisions. */
  providerCoverage?: ProviderCoverage[];
  implementedBy?: ImplementingComponent[];
  id: string;
  title: string;
  family: string;
  implementation: string;
  /** First responsible role. Empty when the control has none. The gate reads this field. */
  responsibleRoleId: string;
  /** Every responsible role, primary first. Omitted on older fixtures; the primary id is used. */
  responsibleRoleIds?: string[];
  /** Item and whole-statement evidence mapping. Omitted when the package has none. */
  itemStatements?: ItemStatementRecord[];
  evidence: EvidenceRecord[];
};

/** A previous stored object kept after a new version was written. */
export type KeptObject = {
  filePath: string;
  /** SHA 256 recorded for this object when it was stored. */
  sha256?: string;
  /** SHA 256 recomputed from the kept bytes. Null when the file was already gone. */
  recomputedDigest: string | null;
  keptAt: string;
};

export type ExportRecord = {
  /** Original export retained when recovery creates this record. */
  regeneratedFrom?: string;
  id: string;
  at: string;
  irHash: string;
  filename: string;
  filePath: string;
  /** SHA 256 of the stored export bytes, recorded when the file is written. */
  sha256?: string;
  /** Serialized XML kept with the session so a later download does not need the artifact file. */
  xml?: string;
  /** Earlier stored files kept for investigation. The current filePath is not in this list. */
  priorObjects?: KeptObject[];
};

export type RenderKind = "word" | "excel";

export type RenderRecord = {
  kind: RenderKind;
  filename: "package.docx" | "package.xlsx";
  at: string;
  irHash: string;
  filePath: string;
  /** SHA 256 of the stored render bytes, recorded when the file is written. */
  sha256?: string;
  exportId: string;
  /** Earlier stored files kept for investigation. The current filePath is not in this list. */
  priorObjects?: KeptObject[];
};

export type ValidationError = {
  id: string;
  check: "Schema" | "Profile";
  message: string;
  oscalPath: string;
  sourceInIr: string;
  hint?: string;
};

export type ValidationRecord = {
  status: "GREEN" | "RED";
  errors: ValidationError[];
  at: string;
  irHash: string;
  exportId: string | null;
  scenario: "current" | "red";
};

export type BaselineControl = {
  id: string;
  title: string;
  implementation: string;
  responsibleRoleId: string;
  evidence: Array<{
    id: string;
    title: string;
    type: string;
    href: string;
  }>;
};

export type BaselineRecord = {
  id: string;
  setAt: string;
  exportId: string;
  irHash: string;
  controls: BaselineControl[];
};

export type BlockedAttempt = {
  id: string;
  at: string;
  action: "export";
  reason: "gate FAIL";
  incomplete: number;
  total: number;
  artifactsWritten: false;
  message: string;
};

export type ParitySample = {
  field: string;
  ir: string;
  oscal: { label: string; match: boolean };
  word: { label: string; match: boolean };
  excel: { label: string; cell: string; match: boolean };
};

export type ParityReport = {
  irHash: string;
  sampled: number;
  matched: number;
  samples: ParitySample[];
};

export type MappingProfile = { catalogId: CatalogId; controlIds: string[] };

export type ArtifactMappingDecision = {
  reviewer?: string;
  profile?: MappingProfile;
  proposalKey: string;
  releaseKey: string;
  artifact: string;
  controls: string[];
  status: "accepted" | "rejected";
  decidedAt: string;
};

/** Persisted workspace. Derived fields live on PackageState. */
export type PersistedState = {
  version: 1;
  loaded: boolean;
  workspaceName: string | null;
  boundaryId: string | null;
  catalogPin: string | null;
  /** Baseline chosen for the next upload, or the baseline bound to a loaded package. Null until the operator chooses. */
  catalogId: CatalogId | null;
  /** Set when the package control list was resolved from the FedRAMP Rev 5 Moderate profile. */
  resolvedProfile?: true;
  ingestKind: IngestKind | null;
  sourceFilename: string | null;
  sourceProfileHref: string | null;
  roles: Role[];
  controls: ControlRecord[];
  exports: ExportRecord[];
  lastValidation: ValidationRecord | null;
  renders: {
    word: RenderRecord | null;
    excel: RenderRecord | null;
  };
  parity: ParityReport | null;
  baseline: BaselineRecord | null;
  blockedAttempts: BlockedAttempt[];
  /** Human decisions for pipeline artifact suggestions. A suggestion alone is never stored as a mapping. */
  pipelineMappingDecisions?: ArtifactMappingDecision[];
  counters: {
    export: number;
    baseline: number;
    attempt: number;
  };
  /** Parser counts from the last OSCAL ingest. Absent for the gold fixture and an empty workspace. */
  importCensus?: ImportCensus | null;
  /** Control fields at the last OSCAL ingest, used to name binder edits since that import. */
  importBaseline?: ImportBaselineControl[];
  /** JSON SSP object from the last JSON ingest. Unmodeled keys are copied onto the next JSON export. */
  sourceSsp?: Record<string, unknown> | null;
  /** Last official SSP schema report, stored through storageKey. */
  schemaReport?: StoredArtifactRef | null;
  /** Last failed import report. The package itself is not replaced. */
  importReport?: StoredArtifactRef | null;
};

export type ImportCensus = {
  bytes: number;
  filename: string;
  controlsFound: number;
  statements: number;
  components: number;
  roles: number;
  evidenceResources: number;
};

export type ImportBaselineControl = {
  id: string;
  implementation: string;
  responsibleRoleIds: string[];
  evidence: Array<{ id: string; title: string; href: string }>;
  parts: Array<{ statementId: string; description: string; evidenceUuids: string[] }>;
};

export type StoredArtifactRef = {
  filePath: string;
  sha256: string;
  storedAt: string;
};

export type MissingField = "implementation" | "responsibleRole" | "evidence";

export type EvidenceView = EvidenceRecord & {
  systemSources?: { repo: string; commit: string }[];
  source?: import("../collector/types").CollectedArtifact["source"];
  displayId?: string;
  valid: boolean;
  errors: string[];
  fileStatus: string;
};

/** Optional supplied coverage metadata. Importing leveraged authorizations is a separate task. */
export type ProviderCoverage = {provider:{id:string;title:string;short?:string;example?:boolean};coverage:"all"|"part"};
export type ImplementingComponent = {id:string;title:string;example?:boolean};
export type ControlView = {
  providerCoverage?: ProviderCoverage[];
  implementedBy?: ImplementingComponent[];
  id: string;
  oscalId: string;
  title: string;
  family: string;
  implementation: string;
  responsibleRoleId: string;
  responsibleRole: string;
  responsibleRoleIds: string[];
  /** Titles parallel to `responsibleRoleIds`. */
  roleLabels: string[];
  itemStatements: ItemStatementRecord[];
  evidence: EvidenceView[];
  validEvidenceCount: number;
  missing: MissingField[];
  complete: boolean;
  /**
   * Uncovered control on a resolved Moderate profile.
   * Empty implementation, no role, and no evidence.
   * Still incomplete until an implementation, a role, and valid evidence are recorded.
   */
  blank?: boolean;
  /**
   * Current stored-release result for this control.
   * Absent on an uploaded package. Blank is not a pass and the control stays visible.
   */
  proposedEvidence?: {key?: string; artifact: string; reasons: string[]; sourcePath?: string; source?: import("../collector/types").CollectedArtifact["source"]}[];
  rollupState?: "blank" | "recorded";
  /** Pipeline id of the release that holds the current result. Empty when blank. */
  rollupReleaseId?: string;
};

export type FamilyView = {
  id: string;
  total: number;
  open: number;
  label: string;
  /** Replaces the open/ok count when the family is read from the release rollup. */
  summary?: string;
};

/** Glyph for a catalog `rel=related` link once a control is selected. */
export type MapGlyph = "mutual" | "outbound" | "reverse";

export type MapDirectedEdge = {
  /** Package control id, for example `AC-2`. */
  fromId: string;
  toId: string;
  /** True when the catalog lists the link in both directions (`mutual_in_catalog`). */
  mutual: boolean;
  /** Catalog path. Design HTML is not a source for this string. */
  citation: string;
};

export type MapFamilyFact = {
  id: string;
  title: string;
  /** Base controls in this family on the FedRAMP Rev5 Moderate profile. Null when the profile has no count. */
  moderateBase: number | null;
  /** Undirected in-package related pairs whose ends share this family. */
  withinPairs: number;
};

export type MapBundle = {
  left: string;
  right: string;
  /** Undirected in-package related pairs between the two families. */
  pairs: number;
};

export type MapEnhancement = {
  id: string;
  label: string;
  title: string;
};

export type MapConstraint = {
  paramId: string;
  description: string;
};

export type MapControlFacts = {
  /** Catalog related targets that are not controls in this package. Labels, not map nodes. */
  outOfSubset: string[];
  outOfSubsetCount: number;
  requiredEnhancements: MapEnhancement[];
  constraints: MapConstraint[];
  catalogOnlyEnhancementIds: string[];
  alterSummary: string | null;
};

/** A catalog `{{ insert: param }}` on a statement item, with the profile constraint when one exists. */
export type StatementParamRef = {
  paramId: string;
  /** Catalog parameter label, for example `frequency`. Empty when the catalog has no label. */
  label: string;
  /** Part id where the insert appears, for example `ac-2_smt.h.1`. */
  itemId: string;
  /** Catalog label of that part, for example `1.`. */
  itemLabel: string | null;
  /** FedRAMP Moderate `set-parameters` constraint. Null when the profile does not set one. */
  constraint: string | null;
};

/** One leaf of an 800-53A assessment-objective part. */
export type AssessmentObjective = {
  id: string;
  label: string;
  prose: string;
};

/** One catalog statement or item part. Depth-1 nodes are the Level 2 rows. */
export type StatementNode = {
  id: string;
  name: string;
  label: string | null;
  prose: string;
  depth: number;
  /** Inserts on this part only. Descendant inserts stay on the child nodes. */
  params: StatementParamRef[];
  children: StatementNode[];
  objectives: AssessmentObjective[];
  objectiveCount: number;
  /** Catalog path. Not a Design HTML string. */
  citation: string;
};

export type StatementPartRow = {
  id: string;
  name: string;
  label: string | null;
  prose: string;
  depth: number;
};

/**
 * Level 2 statement focus for one control (Design 11a).
 * Statement prose and 800-53A objectives come from the catalog.
 * Parameter constraints come from the FedRAMP Rev5 Moderate profile.
 * By-statement implementation and item-level evidence links are not in the package, so they are not invented.
 */
export type ControlStatements = {
  controlId: string;
  statementId: string | null;
  /** Depth-1 statement items (a., b., …). */
  items: StatementNode[];
  /** Depth-first catalog parts, including the statement root. Claim-checked against the truth table for AC-2. */
  parts: StatementPartRow[];
  /** Catalog parameter labels and profile constraints for inserts in this control's prose. */
  paramIndex: Record<string, { label: string; constraint: string | null }>;
};

/** Level 1 package map (Design 10a / 10b / 10c). Edges come from the Rev5 catalog, not from mock copy. */
export type PackageMapView = {
  level: 1;
  available: boolean;
  note: string;
  catalogVersion: string | null;
  catalogTitle: string | null;
  profileTitle: string | null;
  profileVersion: string | null;
  subsetPin: "fedramp-rev5-subset@2026.09";
  /** Loaded control ids are exactly the 12-control subset pin. */
  subsetMatch: boolean;
  directedInSubset: number;
  undirectedPairs: number;
  families: MapFamilyFact[];
  bundles: MapBundle[];
  edges: MapDirectedEdge[];
  byControl: Record<string, MapControlFacts>;
  /** Statement items for Level 2 focus. Keyed by the package control id, for example `AC-2`. */
  statements: Record<string, ControlStatements>;
};

export type CatalogChoice = {
  id: CatalogId;
  label: string;
  pin: string;
  status: CatalogStatus;
  note: string;
};

/** Active catalog on the package view. Unselected until Rev5 or 20x is chosen. */
export type CatalogView = {
  id: CatalogId | null;
  label: string;
  pin: string | null;
  status: CatalogStatus | "unselected";
  note: string;
  bound: boolean;
};

export type PackageState = {
  loaded: boolean;
  workspaceName: string | null;
  boundaryId: string | null;
  catalogPin: string | null;
  catalogReadOnly: true;
  catalog: CatalogView;
  catalogChoices: CatalogChoice[];
  ingestKind: IngestKind | null;
  sourceFilename: string | null;
  sourceProfileHref: string | null;
  disclaimer: { id: "D6"; text: string };
  roles: Role[];
  controls: ControlView[];
  families: FamilyView[];
  map: PackageMapView;
  inScopeCount: number;
  irHash: string | null;
  gate: {
    status: "EMPTY" | "FAIL" | "PASS";
    incomplete: number;
    complete: number;
    total: number;
    label: string;
    failClosed: true;
    incompleteControlIds: string[];
    /** Uncovered controls on a resolved profile. Included in incomplete. Absent when none are uncovered. */
    blank?: number;
    /** Incomplete controls that have some of implementation, role, or evidence, and are not blank. */
    partial?: number;
    /** Base and enhancement counts from the resolved profile file. Null until that profile is resolved. */
    profile?: {
      resolved: boolean;
      total: number | null;
      base: number | null;
      enhancements: number | null;
      reason: string | null;
    };
    families?: Array<{
      id: string;
      total: number;
      complete: number;
      incomplete: number;
      blank: number;
      partial: number;
      base: number | null;
      enhancements: number | null;
    }>;
    /** One row per in-scope control, in package order. */
    controlReasons?: Array<{
      id: string;
      status: "complete" | "blank" | "partial" | "incomplete";
      reasons: Array<"missing implementation" | "missing role" | "missing evidence">;
    }>;
    /** Stored statement parts only. Catalog parts with nothing stored are on the parts route. */
    parts?: Array<{
      controlId: string;
      statementId: string;
      status: "complete" | "blank" | "partial";
      reasons: Array<"missing implementation" | "missing evidence">;
    }>;
    /** Incomplete control ids in package order. For a resolved profile that is profile order. */
    nextIncompleteControlIds?: string[];
  };
  pipeline: {
    oscal: {
      status: "locked" | "ready" | "written";
      filename: string;
      exportId: string | null;
      writtenAt: string | null;
      stale: boolean;
      lockedReason: string | null;
    };
    validator: {
      status: "NOT_RUN" | "GREEN" | "RED";
      errorCount: number;
      errors: ValidationError[];
      at: string | null;
      scenario: "current" | "red" | null;
      exportId: string | null;
    };
    word: {
      status: "locked" | "ready" | "rendered";
      filename: "package.docx";
      renderedAt: string | null;
      stale: boolean;
      lockedReason: string | null;
    };
    excel: {
      status: "locked" | "ready" | "rendered";
      filename: "package.xlsx";
      renderedAt: string | null;
      stale: boolean;
      lockedReason: string | null;
    };
    baseline: {
      id: string | null;
      setAt: string | null;
      exportId: string | null;
      enabled: boolean;
      reason: string;
    };
    parity: ParityReport | null;
  };
  blockedAttempts: BlockedAttempt[];
  cli: {
    note: string;
    validate: string;
    export: string;
  };
  future: {
    liveConnections: 0;
    note: string;
  };
};

export type NamedDelta = {
  kind: "Modified" | "Added" | "Removed";
  field: "implementation" | "responsibleRole" | "evidence";
  label: string;
  controlId: string;
  controlTitle: string;
  evidenceId?: string;
  evidenceTitle?: string;
  before?: string;
  after?: string;
  affects: Array<{
    artifact: "package-oscal.xml" | "Word render" | "Excel render";
    status: "Stale" | "Current" | "Not rendered";
    detail: string;
  }>;
};

export type ChangesReport = {
  baseline: {
    id: string;
    setAt: string;
    exportId: string;
    irHash: string;
  } | null;
  current: {
    irHash: string | null;
    gate: PackageState["gate"]["status"];
    controlCount: number;
  };
  summary: {
    changed: number;
    unchanged: number;
    total: number;
  };
  deltas: NamedDelta[];
  next: string[];
  note: string;
};

export type Ctx = {
  root: string;
  now?: () => Date;
  /** Browser session id. Ownership segment for stored evidence and exports. */
  ownerKey?: string;
};

export type EvidenceInput = {
  title: string;
  type: string;
  href: string;
  sha256?: string;
};
