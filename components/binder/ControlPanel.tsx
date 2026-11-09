"use client";

import { useEffect, useState, type ReactNode } from "react";
import { EVIDENCE_TYPES } from "@/lib/aegis/constants";
import { Term } from "../chrome/Term";
import { Sa1Responsibility } from "./Sa1Demo";
import { descendantParams, directedLinksFor, findStatement, itemEvidenceLinks, openParamChip, packageStillFails, parameterPhrase, partitionConstraints, proseSegments, statementAddressed, subsetBaselineNote } from "@/lib/aegis/map-view";
import type { ControlView, MapControlFacts, PackageState, StatementNode } from "@/lib/aegis/types";

const SEPTEMBER_HREF = "evidence/ac-2/iam-review-2026-09.pdf";

function ControlContext({ compact, children }: { compact?: boolean; children: ReactNode }) {
  if (!compact) return <>{children}</>;
  return <details className="planning-context"><summary>Relationships & baseline details</summary>{children}</details>;
}

function needsLine(missing: string[]): string {
  if (missing.join(",") === "implementation,responsibleRole,evidence") {
    return "Needs implementation, responsibleRole and 1 valid evidence";
  }
  return `Needs ${missing.join(", ")}`;
}

type Props = {
  sa1Demo?: boolean;
  onPrepareSa1?: () => void;
  pkg: PackageState;
  control: ControlView;
  busy: boolean;
  error: string | null;
  problems: string[];
  implementation: string;
  role: string;
  title: string;
  type: string;
  href: string;
  fieldsOpen: boolean;
  evidenceFormOpen: boolean;
  onImplementation: (value: string) => void;
  onRole: (value: string) => void;
  onTitle: (value: string) => void;
  onType: (value: string) => void;
  onHref: (value: string) => void;
  onEditFields: () => void;
  onOpenEvidenceForm: () => void;
  onAdd: () => void;
  onSave: () => void;
  onAttachFile: (file: File) => void;
  onFillAc2: () => void;
  onFillAu2: () => void;
  onFillCm6: () => void;
  onRetarget: (evidenceId: string) => void;
  onClose: () => void;
  level2: boolean;
  selectedItemId: string | null;
  onExpand: () => void;
  onSelectItem: (id: string) => void;
  extraRoles: string[];
  onExtraRoles: (roles: string[]) => void;
  devChrome: boolean;
  savedPartial: boolean;
};

export function ControlPanel(props: Props) {
  const { control, pkg } = props;
  const fieldsReady = Boolean(props.implementation.trim() && props.role.trim());
  const draftPending = Boolean(props.title.trim() || props.href.trim());
  const evidenceRejected = props.problems.length > 0;
  const duplicate = control.evidence.some(
    (item) => props.title.trim() && item.title.trim().toLowerCase() === props.title.trim().toLowerCase(),
  );
  const draftOk = Boolean(props.title.trim()) && hrefOk(props.href) && !duplicate;
  const staged = draftPending && draftOk && !evidenceRejected;
  const structuralHrefBad = Boolean(props.href.trim()) && !hrefOk(props.href);
  const evidenceBlocked = evidenceRejected || structuralHrefBad;
  const savedExtras = control.roleLabels.slice(1).join("|");
  const dirty =
    props.implementation !== control.implementation
    || props.role !== control.responsibleRole
    || props.extraRoles.join("|") !== savedExtras;
  const failLine = packageStillFails(control.id, pkg.controls, pkg.gate.status);
  const evidenceEmpty = control.validEvidenceCount < 1 && !staged;
  const titleEmpty = evidenceEmpty && !props.title.trim();
  const linkBlank = evidenceEmpty && !props.href.trim();
  const pendingEvidence = Boolean(props.title.trim() && props.href.trim()) && !structuralHrefBad;
  const formDirty = dirty || staged || pendingEvidence;
  const readyToSave = fieldsReady && (control.validEvidenceCount >= 1 || staged) && !control.complete && !evidenceBlocked;
  const canSave = !props.busy && !evidenceBlocked && formDirty;
  const showForm = !props.sa1Demo || props.evidenceFormOpen || evidenceBlocked;
  const collapsed = !props.fieldsOpen && fieldsReady;
  const [baselineOpen, setBaselineOpen] = useState(false);
  const [outsideOpen, setOutsideOpen] = useState(false);
  const [fieldsPeek, setFieldsPeek] = useState(false);
  const [evidencePeek, setEvidencePeek] = useState(false);
  useEffect(() => {
    setBaselineOpen(false);
    setOutsideOpen(false);
    setFieldsPeek(false);
    setEvidencePeek(false);
  }, [control.id]);
  const fieldsFolded = baselineOpen && !fieldsPeek;
  const evidenceFolded = baselineOpen && !evidencePeek;
  const facts = pkg.map.byControl[control.id] ?? null;
  const links = pkg.map.available ? directedLinksFor(pkg.map.edges, control.id) : null;
  const statements = pkg.map.statements[control.id] ?? null;
  const itemNode = props.level2 && props.selectedItemId && statements
    ? findStatement(statements.items, props.selectedItemId)
    : null;
  const artifacts = pkg.gate.status === "PASS" ? "artifacts open" : pkg.gate.status === "FAIL" ? "draft export" : "no package";
  const gateOpen = pkg.gate.status === "PASS";
  const formMissing: string[] = [];
  if (!props.implementation.trim()) formMissing.push("implementation");
  if (!props.role.trim() && !props.extraRoles.some((item) => item.trim())) formMissing.push("responsibleRole");
  if (control.validEvidenceCount < 1 && !staged) formMissing.push("evidence");
  let saveReason = needsLine(formMissing);
  if (control.complete && !dirty && !draftPending && !evidenceBlocked) saveReason = "Saved · control complete";
  else if (props.savedPartial && !dirty && !draftPending && !control.complete && !evidenceBlocked && formMissing.length > 0) {
    saveReason = `Saved. Still needs: ${formMissing.join(", ")}`;
  } else if ((canSave && fieldsReady && (control.validEvidenceCount >= 1 || staged)) || formMissing.length === 0) {
    saveReason = "Required fields and 1 valid evidence present";
  }

  return (
    <aside className={`panel ${itemNode ? "panel-statement" : ""}${props.sa1Demo ? " planning-panel" : ""}`}>
      {itemNode && statements ? (
        <div className="panel-scroll">
          <StatementFocus
            control={control}
            statements={statements}
            selectedItemId={props.selectedItemId}
            onSelectItem={props.onSelectItem}
            onClose={props.onClose}
          />
        </div>
      ) : (
      <div className="panel-body">
      <header className="panel-head">
        <div className="label-row" style={{ justifyContent: "space-between" }}>
          <h2>
            <span className="mono panel-id">{control.id}</span> <span className="panel-name">{control.title}</span>
          </h2>
          <button type="button" className="icon-btn" aria-label="Close panel" onClick={props.onClose}>
            ×
          </button>
        </div>
        {!props.level2 && failLine && (!props.sa1Demo || !control.complete) && (
          <p className="hint panel-fail" data-testid="package-still-fails">{failLine}</p>
        )}
      </header>
      <div className="panel-scroll">
      {props.sa1Demo && <Sa1Responsibility id={control.id} />}
      {props.sa1Demo && control.id === "AU-2" && !control.complete && <section className="panel-block"><button className="btn primary" disabled={props.busy} onClick={props.onPrepareSa1}>Add example evidence</button><p className="hint">Placeholder reference. Review, then Save.</p></section>}

      <ControlContext compact={props.sa1Demo}>
      <section className="panel-block" data-testid="related-links">
        <div className="label-row" style={{ justifyContent: "space-between" }}>
          <span className="kicker">Relationships</span>
          {!props.level2 && statements && statements.items.length > 0 && (
            <button type="button" className="text-btn focus-open" onClick={props.onExpand}>
              Open {control.id} in Level 2 →
            </button>
          )}
        </div>
        {!pkg.map.available || !links || !facts ? (
          <p className="hint">{pkg.map.note}</p>
        ) : (
          <RelationshipLines
            pkg={pkg}
            control={control}
            links={links}
            facts={facts}
            outsideOpen={outsideOpen}
            onToggleOutside={() => setOutsideOpen((value) => !value)}
          />
        )}
      </section>

      {props.level2 && !itemNode && (
        <StatementFocus
          control={control}
          statements={statements}
          selectedItemId={props.selectedItemId}
          onSelectItem={props.onSelectItem}
          onClose={props.onClose}
        />
      )}

      {facts && pkg.map.available && (
        <BaselineFacts
          facts={facts}
          labels={pkg.map.statements[control.id]?.paramIndex ?? {}}
          items={pkg.map.statements[control.id]?.items ?? []}
          packageIds={new Set(pkg.controls.map((item) => item.id.toLowerCase()))}
          subsetNote={subsetBaselineNote(pkg.map.subsetMatch, pkg.inScopeCount)}
          open={baselineOpen}
          onToggle={() => setBaselineOpen((value) => !value)}
        />
      )}
      </ControlContext>
      </div>
      <div className="panel-tail">

      <section className="panel-block">
        {fieldsFolded ? (
          <button type="button" className="fold-row" onClick={() => setFieldsPeek(true)}>
            <span>Structured fields</span>
            <span>Show ▾</span>
          </button>
        ) : (
        <>
        <span className="kicker">Structured fields</span>
        {collapsed ? (
          <div className="checks">
            <span>✓ implementation</span>
            <span>✓ responsibleRole · {props.role}</span>
            <button type="button" className="text-btn" onClick={props.onEditFields}>
              Edit structured fields
            </button>
          </div>
        ) : (
          <div className="stack">
            <label className={props.implementation.trim() ? "" : "field-empty"}>
              <span className="label-row">
                <span>implementation</span>
                <FieldStatus
                  saved={control.complete && !dirty && Boolean(control.implementation)}
                  valid={Boolean(props.implementation.trim())}
                  empty={!props.implementation.trim()}
                />
              </span>
              <textarea
                readOnly={Boolean(control.rollupState)}
                value={props.implementation}
                placeholder={`Describe how this boundary implements ${control.id}.`}
                aria-invalid={!props.implementation.trim() || undefined}
                data-empty={!props.implementation.trim() ? "true" : undefined}
                onChange={(event) => props.onImplementation(event.target.value)}
              />
            </label>
            <label className={props.role.trim() ? "" : "field-empty"}>
              <span className="label-row">
                <span>responsibleRole</span>
                <FieldStatus
                  saved={control.complete && !dirty && Boolean(control.responsibleRole)}
                  valid={Boolean(props.role.trim())}
                  empty={!props.role.trim()}
                />
              </span>
              <select
                disabled={Boolean(control.rollupState)}
                value={props.role}
                aria-label="responsibleRole"
                aria-invalid={!props.role.trim() || undefined}
                data-empty={!props.role.trim() ? "true" : undefined}
                onChange={(event) => props.onRole(event.target.value)}
              >
                <option value="">Select role</option>
                {pkg.roles.map((role) => (
                  <option key={role.id} value={role.title}>
                    {role.title}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}
        </>
        )}
      </section>

      <section className="panel-block">
        {evidenceFolded ? (
          <button type="button" className="fold-row" onClick={() => setEvidencePeek(true)}>
            <span>Evidence</span>
            <span>Show ▾</span>
          </button>
        ) : (
        <>
        <div className="label-row">
          <span className="kicker">
            {control.complete && !dirty ? `Evidence · ${control.validEvidenceCount} linked` : "Evidence · required ≥ 1 valid"}
          </span>
          {!control.complete && <span className="hint">{control.validEvidenceCount} valid</span>}
          {!showForm && (
            <button type="button" className="text-btn" onClick={props.onOpenEvidenceForm}>
              Add evidence
            </button>
          )}
        </div>
        <div className="stack">
          {control.evidence.map((item) => (
            <article key={item.id} className={`ev ${item.valid ? "ok" : "bad"}`}>
              <div className="ev-line">
                <strong className="mono">{item.displayId ?? item.id}</strong>
                <span className="ev-title">{item.title}</span>
                <span className={item.valid ? "pill pass" : "pill miss"}>{item.valid ? "Valid" : "Invalid"}</span>
              </div>
              <div className="hint ev-meta" title={evidenceMetaTitle(item)}>
                {props.sa1Demo ? `${item.type} · ${item.fileStatus}` : evidenceMetaText(item)}
              </div>
              {!item.valid && item.errors.map((message) => (
                <div key={message} className="hint bad-text">{message}</div>
              ))}
              {item.href.includes("iam-review-2026-08.pdf") && (
                <button type="button" className="text-btn" onClick={() => props.onRetarget(item.id)} disabled={props.busy}>
                  Point {item.id} at September file
                </button>
              )}
            </article>
          ))}
          {control.evidence.length === 0 && <p className="hint">No evidence linked.</p>}
          {evidenceRejected && (
            <article className="ev bad">
              <div className="label-row">
                <strong>{props.title.trim() || "Evidence draft"}</strong>
                <span className="pill miss">Invalid</span>
              </div>
              {props.problems.map((problem) => (
                <div key={problem} className="hint bad-text">{problem}</div>
              ))}
              {props.href.trim() && <div className="mono hint">{props.href}</div>}
            </article>
          )}
          {staged && (
            <article className="ev staged">
              <div className="label-row">
                <strong>{props.title.trim()}</strong>
                <span className="pill ready">Staged</span>
              </div>
              <div className="hint">{props.type}</div>
              <div className="mono hint">{props.href}</div>
              <div className="hint">staged, saves with the control</div>
            </article>
          )}
          {showForm && (
            <div className="stack evidence-form">
              <label className={titleEmpty ? "field-empty" : ""}>
                <span className="label-row">
                  <span>Title {titleEmpty ? <span className="req">required</span> : null}</span>
                  <FieldStatus saved={false} valid={false} empty={titleEmpty} />
                </span>
                <input
                  value={props.title}
                  placeholder="e.g. Quarterly account review"
                  aria-invalid={titleEmpty || undefined}
                  data-empty={titleEmpty ? "true" : undefined}
                  onChange={(event) => props.onTitle(event.target.value)}
                />
              </label>
              <label>
                Type
                <select value={props.type} onChange={(event) => props.onType(event.target.value)}>
                  {EVIDENCE_TYPES.map((item) => (
                    <option key={item}>{item}</option>
                  ))}
                </select>
              </label>
              <label className={evidenceEmpty ? "field-empty" : ""}>
                <span className="label-row">
                  <span>Link or path {evidenceEmpty ? <span className="req">required</span> : null}</span>
                  <FieldStatus
                    saved={false}
                    valid={!evidenceEmpty && Boolean(props.href.trim())}
                    empty={linkBlank}
                  />
                </span>
                <input
                  value={props.href}
                  placeholder="https:// or evidence/ac-2/…"
                  aria-invalid={evidenceEmpty || undefined}
                  data-empty={linkBlank ? "true" : undefined}
                  onChange={(event) => props.onHref(event.target.value)}
                />
              </label>
              <label>
                Attach file
                <input
                  type="file"
                  accept=".pdf,.png,.jpg,.jpeg,.webp,.txt,.json,.csv,.xml,image/*,application/pdf"
                  disabled={props.busy}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = "";
                    if (file) props.onAttachFile(file);
                  }}
                />
              </label>
              <button
                type="button"
                className="btn ghost"
                onClick={props.onAdd}
                disabled={props.busy || (!props.title.trim() && !props.href.trim())}
              >
                Add evidence
              </button>
            </div>
          )}
          {props.devChrome && (
          <div className="row">
            {control.id === "AC-2" && (
              <button type="button" className="btn ghost" onClick={props.onFillAc2} disabled={props.busy}>
                Fill AC-2 example
              </button>
            )}
            {control.id === "AU-2" && (
              <button type="button" className="btn ghost" onClick={props.onFillAu2} disabled={props.busy}>
                Fill AU-2 evidence
              </button>
            )}
            {control.id === "CM-6" && (
              <button type="button" className="btn ghost" onClick={props.onFillCm6} disabled={props.busy}>
                Fill CM-6 implementation
              </button>
            )}
          </div>
          )}
          {(control.validEvidenceCount >= 1 || staged) && !evidenceRejected && (
            <p className="hint ev-optional">More evidence is optional.</p>
          )}
        </div>
        {props.error && <div className="banner fail">{props.error}</div>}
        </>
        )}
      </section>
      <p className="lineage">
        <span className="kicker">Lineage</span>
        <span className="lin"><Term id="pin">pin</Term></span>
        <span className="lin-sep">›</span>
        <span className="lin">{control.family}</span>
        <span className="lin-sep">›</span>
        <span className={`lin ${control.complete ? "" : "bad"}`}>{control.id}</span>
        <span className="lin-sep">›</span>
        <span className={`lin ${gateOpen ? "" : "bad"}`}><Term id="gate">gate {pkg.gate.status}</Term></span>
        <span className="lin-sep">›</span>
        <span className="lin quiet">{pkg.gate.status === "FAIL" ? <Term id="wip">{artifacts}</Term> : artifacts}</span>
      </p>
      </div>
      </div>
      )}

      <div className="savebar">
        <button type="button" className={`btn save ${canSave ? "primary" : ""}`} onClick={props.onSave} disabled={!canSave}>
          Save
        </button>
        {evidenceBlocked ? (
          <>
            <p className="hint bad-text">Save blocked</p>
            <p className="hint">Save needs required fields and at least 1 valid evidence</p>
          </>
        ) : props.level2 && statements && statements.items.length > 0 ? (
          <p className="hint" data-testid="level2-saved-line">{statementSavedLine(control, statements)}</p>
        ) : (
          <>
            {readyToSave && !props.sa1Demo && <p className="hint ok-text">Ready to save</p>}
            <p className={readyToSave ? "hint ok-text" : "hint"} data-testid="save-hint">{saveReason}</p>
          </>
        )}
      </div>
    </aside>
  );
}

function statementSavedLine(control: ControlView, statements: NonNullable<PackageState["map"]["statements"][string]>): string {
  const total = statements.items.length;
  const addressed = statements.items.filter((item) => statementAddressed(control, item.id)).length;
  const clock = new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  return `Saved ${clock} · ${addressed} of ${total} items addressed`;
}

function RelationshipLines({
  pkg,
  control,
  links,
  facts,
  outsideOpen,
  onToggleOutside,
}: {
  pkg: PackageState;
  control: ControlView;
  links: NonNullable<ReturnType<typeof directedLinksFor>>;
  facts: NonNullable<PackageState["map"]["byControl"][string]>;
  outsideOpen: boolean;
  onToggleOutside: () => void;
}) {
  const family = pkg.map.families.find((item) => item.id === control.family);
  const inFamily = pkg.controls.filter((item) => item.family === control.family).length;
  const gaps = [
    !control.responsibleRole.trim() ? "no role" : "",
    control.validEvidenceCount < 1 ? "no evidence" : "",
  ].filter(Boolean);
  const incomplete = new Set(pkg.controls.filter((item) => !item.complete).map((item) => item.id));
  return (
    <>
      <div className="rel-family">
        <b>{control.family} · {family?.title ?? control.family}</b>
        {family?.moderateBase != null && (
          <span className="hint"> · {inFamily} of {family.moderateBase} Moderate base controls</span>
        )}
        {gaps.length > 0 && <span className="rel-miss"> · {gaps.join(" · ")}</span>}
      </div>
      <div className="rel-row">
        <ChipGroup testId="related-mutual" mark="⇄" ids={links.mutual.map((link) => link.otherId)} incomplete={incomplete} citations={links.mutual.map((link) => link.citation)} />
        <ChipGroup testId="related-outbound" mark="→" ids={links.outbound.map((link) => link.otherId)} incomplete={incomplete} citations={links.outbound.map((link) => link.citation)} />
        <ChipGroup testId="related-reverse" mark="←" ids={links.reverse.map((link) => link.otherId)} incomplete={incomplete} citations={links.reverse.map((link) => link.citation)} />
        {facts.outOfSubsetCount > 0 && (
          <button type="button" className="text-btn rel-outside" data-testid="related-outside" aria-expanded={outsideOpen} onClick={onToggleOutside}>
            +{facts.outOfSubsetCount} outside subset
          </button>
        )}
      </div>
      {outsideOpen && facts.outOfSubset.length > 0 && (
        <ul className="fact-list" data-testid="related-outside-list">
          {facts.outOfSubset.map((id) => <li key={id}>{id}</li>)}
        </ul>
      )}
    </>
  );
}

function ChipGroup({
  testId,
  mark,
  ids,
  incomplete,
  citations,
}: {
  testId: string;
  mark: string;
  ids: string[];
  incomplete: Set<string>;
  citations: string[];
}) {
  if (ids.length === 0) return null;
  return (
    <div className="rel-group" data-testid={testId} title={citations.join("\n")}>
      <span>{mark}</span>
      {ids.map((id) => (
        <span key={id} className={incomplete.has(id) ? "rel-chip bad" : "rel-chip"}>{id}</span>
      ))}
    </div>
  );
}

function StatementFocus({
  control,
  statements,
  selectedItemId,
  onSelectItem,
  onClose,
}: {
  control: ControlView;
  statements: PackageState["map"]["statements"][string] | null;
  selectedItemId: string | null;
  onSelectItem: (id: string) => void;
  onClose: () => void;
}) {
  const node = statements && selectedItemId ? findStatement(statements.items, selectedItemId) : null;
  if (!statements || statements.items.length === 0) {
    return (
      <section className="panel-block" data-testid="statement-focus">
        <span className="kicker">Statement · catalog, read only</span>
        <p className="hint">No statement items in the Rev5 catalog for this control.</p>
      </section>
    );
  }
  if (!node) {
    return (
      <section className="panel-block" data-testid="statement-focus">
        <span className="kicker">Statement · catalog, read only</span>
        <p className="hint">Select a statement item.</p>
      </section>
    );
  }
  const params = descendantParams(node);
  const index = statements.paramIndex;
  const headline = node.prose.replace(/[{}]/g, " ").trim().split(/\s+/).slice(0, 2).join(" ");
  const evidenceCount = itemEvidenceLinks(control).filter((link) => link.statementId === node.id).length;
  return (
    <section className="panel-block statement-lead" data-testid="statement-focus">
      <div className="label-row" style={{ justifyContent: "space-between" }}>
        <h2>
          <span className="mono">{control.id} · {node.label ?? node.id}</span> {headline}
        </h2>
        <button type="button" className="icon-btn" aria-label="Close panel" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="pills">
        <span className={statementAddressed(control, node.id) ? "pill pass" : "pill warn"}>
          {statementAddressed(control, node.id) ? "Addressed" : "Not addressed"}
        </span>
        <span className="pill">{evidenceCount} evidence</span>
        <span className="pill">{node.objectiveCount} objective{node.objectiveCount === 1 ? "" : "s"}</span>
      </div>
      <p className="hint">By-statement coverage is display only. It does not change the completeness gate.</p>
      <span className="kicker">Statement · catalog, read only</span>
      <p data-testid="statement-prose" data-prose={node.prose}>
        <StatementProse prose={node.prose} index={index} />
      </p>
      {node.children.length > 0 && (
        <ul className="statement-list" data-testid="statement-children">
          {node.children.map((child) => (
            <li key={child.id}>
              <button type="button" className="text-btn" onClick={() => onSelectItem(child.id)}>
                <span className="mono">{child.label ?? child.id}</span>
              </button>{" "}
              <StatementProse prose={child.prose} index={index} />
            </li>
          ))}
        </ul>
      )}
      <span className="kicker">Parameters</span>
      {params.length === 0 ? (
        <p className="hint">No organization-defined parameters on this item.</p>
      ) : (
        <ul className="statement-list" data-testid="statement-parameters">
          {params.map((param) => (
            <li key={`${param.itemId}-${param.paramId}`}>
              <code title={param.paramId.toLowerCase().includes("odp") ? "organization defined parameter" : undefined}>{param.paramId}</code>
              {param.label ? ` · ${param.label}` : ""}
              {param.constraint ? (
                <span data-constraint={param.paramId}> · FedRAMP · {param.constraint}</span>
              ) : (
                <span> · no FedRAMP constraint</span>
              )}
              <div className="hint">CSP value · not recorded</div>
            </li>
          ))}
        </ul>
      )}
      <span className="kicker"><abbr title="implemented requirement">IR</abbr> · Implementation · by-statement {node.id}</span>
      <p className="hint" data-testid="statement-implementation">
        {itemStatementText(control, node.id) ?? (
          <>
            No by-statement entry in this package.
            {control.implementation.trim()
              ? ` Control implementation: ${control.implementation}`
              : " The control implementation field is empty."}
          </>
        )}
      </p>
      <span className="kicker">Evidence for {node.label ?? node.id}</span>
      <ItemEvidence control={control} statementId={node.id} />
      <span className="kicker">800-53A objective</span>
      {node.objectives.length === 0 ? (
        <p className="hint">No assessment objective in the catalog for this item.</p>
      ) : (
        <ul className="statement-list" data-testid="statement-objectives">
          {node.objectives.map((objective) => (
            <li key={objective.id}>
              <span className="mono" title={`${node.objectives.length} assessment objectives from 800-53A`}>{objective.label || objective.id}</span>{" "}
              <StatementProse prose={objective.prose} index={index} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function StatementProse({
  prose,
  index,
}: {
  prose: string;
  index: Record<string, { label: string; constraint: string | null }>;
}) {
  return (
    <>
      {proseSegments(prose, index).map((segment, key) => {
        if (segment.kind === "text") return <span key={key}>{segment.text}</span>;
        return (
          <span key={key} className={segment.kind === "constraint" ? "l2-insert constraint" : "l2-insert open"}>
            {segment.text}
          </span>
        );
      })}
    </>
  );
}

function GlyphLine({
  testId,
  mark,
  label,
  ids,
  citations,
}: {
  testId: string;
  mark: string;
  label: string;
  ids: string[];
  citations: string[];
}) {
  if (ids.length === 0) return null;
  return (
    <p data-testid={testId} title={citations.join("\n")}>
      <span className="l1-glyph">{mark}</span> {ids.join(" ")} <span className="hint">{label}</span>
    </p>
  );
}

function BaselineFacts({
  facts,
  labels,
  items,
  packageIds,
  subsetNote,
  open,
  onToggle,
}: {
  facts: MapControlFacts;
  labels: Record<string, { label: string; constraint: string | null }>;
  items: readonly StatementNode[];
  packageIds: ReadonlySet<string>;
  subsetNote: string;
  open: boolean;
  onToggle: () => void;
}) {
  const { base, more } = partitionConstraints(facts.constraints, packageIds);
  return (
    <section className="panel-block" data-testid="baseline-section">
      <button type="button" className="baseline-row" aria-expanded={open} onClick={onToggle}>
        <span>
          <span className="kicker">Baseline · FedRAMP Rev5 Moderate</span>
          <span className="hint">{facts.requiredEnhancements.length} required enh (not in subset) · {base.length} param constraints</span>
        </span>
        <span className="baseline-show">{open ? "Hide ▴" : "Show ▾"}</span>
      </button>
      {open && (
        <div data-testid="baseline-detail">
          {base.length === 0 ? (
            <p className="hint">No FedRAMP set-parameters for this control.</p>
          ) : (
            <div className="odp-grid" data-testid="baseline-constraints">
              {base.map((item) => {
                const catalog = labels[item.paramId]?.label?.trim() || "";
                return (
                  <div key={item.paramId} className="odp-row">
                    <code title={item.paramId}>{openParamChip(item.paramId)}</code>
                    <span className="odp-label">{parameterPhrase(item.paramId, items, catalog || item.paramId)}</span>
                    <strong>{item.description}</strong>
                  </div>
                );
              })}
            </div>
          )}
          {more > 0 && (
            <p className="hint odp-more">{more} more parameters in enhancements not in subset</p>
          )}
          <p className="hint enh-heading">Required enhancements · not in this subset</p>
          <p className="hint" data-testid="subset-note">{subsetNote}</p>
          {facts.requiredEnhancements.length === 0 ? (
            <p className="hint">No Moderate enhancements outside this subset.</p>
          ) : (
            <div className="enh-chips" data-testid="baseline-enhancements">
              {facts.requiredEnhancements.map((item) => (
                <span key={item.id} className="enh-chip" title={item.title}>
                  {item.label}
                  <span className="sr-only"> {item.title}</span>
                </span>
              ))}
            </div>
          )}
          {facts.alterSummary && <p className="hint">{facts.alterSummary}</p>}
          <p className="hint">Reference only. The completeness gate checks fields and evidence.</p>
        </div>
      )}
    </section>
  );
}

function FieldStatus({ saved, valid, empty }: { saved: boolean; valid: boolean; empty?: boolean }) {
  if (saved) return <span className="status saved">saved</span>;
  if (valid) return <span className="status valid">valid</span>;
  if (empty) {
    return (
      <span className="status empty">
        <span className="mark-bad" aria-hidden="true" />
        required · empty
      </span>
    );
  }
  return null;
}

function itemStatementText(control: ControlView, statementId: string): string | null {
  const record = control.itemStatements.find((item) => item.statementId === statementId);
  const text = record?.description.trim() ?? "";
  return text || null;
}

function ItemEvidence({ control, statementId }: { control: ControlView; statementId: string }) {
  const links = itemEvidenceLinks(control).filter((link) => link.statementId === statementId);
  const linked = new Set(links.map((link) => link.evidenceId));
  const available = control.evidence.filter((item) => !linked.has(item.id));
  if (links.length === 0) {
    return (
      <div data-testid="statement-evidence">
        <p className="hint">
          No evidence is linked to this statement item. Control evidence stays on the control and is not an item mapping.
        </p>
        <span className="statement-actions">
          <button type="button" className="text-btn">Link</button>
        </span>
      </div>
    );
  }
  return (
    <div data-testid="statement-evidence">
      <ul className="statement-list">
        {links.map((link, index) => {
          const evidence = control.evidence.find((item) => item.id === link.evidenceId);
          return (
            <li key={link.evidenceId} className="label-row">
              <span><span className="mono">{link.evidenceId}</span> {evidence?.title}</span>
              <span className="statement-actions">
                <button type="button" className="text-btn">Unlink</button>
                {index === links.length - 1 && available.length > 0 && (
                  <button type="button" className="text-btn">Link</button>
                )}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function evidenceMetaText(item: { valid: boolean; fileStatus: string; type: string; href: string }): string {
  const lead = item.valid ? "feeds OSCAL back-matter, Word, Excel · " : "";
  const href = item.href ? ` · ${wrappedHref(item.href)}` : "";
  return `${lead}${item.fileStatus} · ${item.type}${href}`;
}

function evidenceMetaTitle(item: { valid: boolean; fileStatus: string; type: string; href: string }): string {
  const lead = item.valid ? "feeds OSCAL back-matter, Word, Excel · " : "";
  const href = item.href ? ` · ${item.href}` : "";
  return `${lead}${item.fileStatus} · ${item.type}${href}`;
}

/** Full URL, wrapped by CSS. No ellipsis character. */
function wrappedHref(href: string): string {
  return href;
}

function hrefOk(href: string): boolean {
  const trimmed = href.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("evidence/") || trimmed.startsWith("workspace-evidence/")) {
    return !trimmed.includes("..") && !trimmed.includes("\\") && !trimmed.includes("\0");
  }
  try {
    const url = new URL(trimmed);
    return url.protocol === "https:" && Boolean(url.hostname);
  } catch {
    return false;
  }
}

export { SEPTEMBER_HREF };
