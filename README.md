# Aegis OSCAL Binder

The Aegis OSCAL Binder is a Next.js app, CLI, and MCP server for preparing
[OSCAL](https://pages.nist.gov/OSCAL/) system security plan (SSP) packages for
review. It ingests an SSP, maps it against a selected FedRAMP catalog baseline,
reports which controls are incomplete, links evidence to controls, and exports
OSCAL that is checked against the official NIST OSCAL 1.1.2 schemas.

The Binder checks package completeness and records evidence. It does not grant
an authorization, accept risk, or close findings on its own. Those decisions
stay with people, and the server enforces that for both the UI and AI agents.

## What it does

- **Ingest.** Upload an OSCAL SSP (JSON or XML) or a CSV control table. The
  Binder builds the workspace, boundary, roles, and control set from the file.
  Malformed files, non-SSP roots, and component-definition-only files are
  rejected with a named error and an import problem report.
- **Catalog baselines.** Choose FedRAMP Rev5 or FedRAMP 20x before loading a
  package. The pin is read-only once a package is loaded. An SSP whose
  `import-profile` names the vendored FedRAMP Rev5 Moderate profile resolves
  that profile, so uncovered controls are added blank and count as incomplete.
- **Completeness gate.** A control is complete only when it has implementation
  text, a responsible role, and at least one valid evidence item. The gate
  reports PASS or FAIL with per-control reasons.
- **Package map.** An interactive map of control families, controls, evidence,
  and catalog relationships, with a side panel for editing implementation
  text, statement parts, and evidence.
- **Export and validation.** Export OSCAL XML (a work-in-progress export is
  allowed while the gate is FAIL), validate it, run an export/import round
  trip, and compare an uploaded SSP without replacing the session. Word and
  Excel renderings come from the same model and unlock only after the gate
  passes and validation is green.
- **Evidence integrity.** Uploaded evidence and exports are stored with a
  SHA-256 digest. Every later read recomputes the digest and refuses a
  mismatch (`DIGEST_MISMATCH`).
- **Release evidence and remediation.** Signed pipeline events
  (`POST /api/pipeline/events`, HMAC-SHA256) and a read-only GitHub App
  record release evidence from CI. Findings can be triaged into a plan
  proposal, retested, and exported as OSCAL 1.1.2 plan-of-action-and-milestones
  (POA&M) and assessment-results files that are validated against the official
  schemas.
- **Evidence collectors.** Read-only collectors for GitHub repositories and for
  AWS accounts (Prowler OCSF output mapped to FedRAMP 20x Key Security
  Indicators). Neither collector writes to the source it reads.
- **Accounts.** Organizations, workspaces, members, and invitations, with
  Google or Microsoft sign-in.

## Stack

- Next.js 15 (App Router), React 19, TypeScript
- Zod and Ajv for request and OSCAL schema validation
- XState for review workflow state
- `@modelcontextprotocol/sdk` for the agent server
- Octokit (GitHub App) for read-only repository and CI access
- Vercel Blob or a local directory for durable storage
- Terraform modules for read-only AWS and GCP reader roles (`infra/`)
- Tests: Node test runner, Vitest, Testing Library, MSW, Playwright

## Run locally

Requires Node.js 20 or later and pnpm.

```bash
pnpm install
cp .env.example .env.local   # optional; every value has a local default or is optional
pnpm dev
```

Open http://localhost:3000. With no storage configured, a local run keeps
sessions, uploads, and exports under `./.data`. Set `AEGIS_DATA_DIR` to use
another directory, or `BLOB_READ_WRITE_TOKEN` to use a private Vercel Blob store.

Sample packages are in `public/samples/` and `fixtures/upload/`. All sample
packages are synthetic.

```bash
pnpm typecheck
pnpm test             # unit and integration tests (Node test runner + Vitest)
pnpm test:e2e:install # once, installs Chromium for Playwright
pnpm build && pnpm test:e2e
```

A `Dockerfile` is included; `pnpm container:smoke` builds the image and checks
its health endpoint.

## CLI

`aegis-oscal` uses the same model as the web app.

```bash
pnpm aegis-oscal validate --fixture gold
pnpm aegis-oscal export --fixture gold --out out/
pnpm aegis-oscal validate --fixture gold --state .data/workspace.json --scenario red
pnpm aegis-oscal aws-scan --fixture fixtures/aws/empty-account --out out/aws-reader
```

The bundled `gold` fixture is intentionally incomplete (3 of 12 controls), so
completeness stays FAIL while export still writes a work-in-progress file.
`--scenario red` re-serializes the package with named defects to show validation
failing. `aws-scan` reads AWS evidence with a read-only role or from a recorded
fixture and never writes to AWS.

## MCP server for AI agents

The Binder exposes its review workflow to AI agents over the
[Model Context Protocol](https://modelcontextprotocol.io/), either over HTTP at
`/api/mcp` or through a stdio server:

```bash
AEGIS_AGENT_TOKEN=... pnpm mcp --origin http://localhost:3000
# or proxy stdio to a deployed instance over HTTPS:
AEGIS_MCP_BASE_URL=https://your-host AEGIS_AGENT_TOKEN=... pnpm mcp
```

Agent tokens are issued per connection from the app (`/api/agent/tokens`) and
carry explicit scopes. The server re-authenticates every tool call, so a revoked
token stops working immediately, and every write is written to an audit log
before it runs (`/api/agent/audit`).

| Tool | Scope | What it does |
| --- | --- | --- |
| `get_package` | read | Summary of the loaded package: catalog pin, families, gate status |
| `list_findings` | read | Findings from collected release evidence |
| `get_gate_status` | read | Completeness and scanner gate state |
| `get_evidence` | read | Evidence linked to a finding or control |
| `get_timeline` | read | Evidence timeline for a control or finding |
| `get_agent_activity` | read | This connection's audited activity |
| `draft_plan` | draft | Draft a remediation plan (risk, action, verification) for a finding |
| `triage_finding` | triage | Propose `fix-now` or `plan-it` with a reason |
| `request_retest` | retest | Request a retest of a finding through its source GitHub Actions workflow |
| `claim_fix` | propose_fix_pr | Claim a fix assignment from the fix runner |
| `get_fix_assignments` | propose_fix_pr | List or renew this agent's fix assignments |
| `propose_fix_pr` | propose_fix_pr | Register or open a fix pull request for a finding |
| `attempt_close` | close | Ask for closure review; refused unless server-collected evidence passes |

A typical agent loop is: read the package and findings, triage a finding, draft
a plan, claim the fix and open a pull request, request a retest, then request
closure review. Agents can propose and draft; acceptance, approval, closure, and
risk decisions remain human-only, and `attempt_close` is refused
(`needs_server_evidence` / `needs_human`) until the server has collected passing
evidence. `pnpm agent:demo` runs the read, triage, draft, retest, and close
steps over stdio against a live GitHub Actions run (it needs a `GH_TOKEN` with
Actions read access).

## Project layout

| Path | Contents |
| --- | --- |
| `app/` | Next.js pages and API routes (`app/api`) |
| `components/` | UI: workspace shell, package map, side panels, export flow |
| `lib/aegis/` | Domain model, ingest, gate, OSCAL export/validation, remediation |
| `lib/agent/` | Agent tokens, scopes, audit log, MCP server, fix runner |
| `lib/collector/` | Read-only GitHub and AWS evidence collectors |
| `lib/github/` | GitHub App integration (read-only permissions) |
| `bin/` | `aegis-oscal` CLI and `aegis-mcp` stdio server |
| `catalogs/`, `schemas/` | Catalog baselines, upstream rule sets, and NIST OSCAL 1.1.2 schemas |
| `fixtures/`, `public/samples/` | Synthetic sample packages and recorded test inputs |
| `infra/` | Terraform for read-only reader roles |
| `test/`, `e2e/` | Unit, integration, component, and Playwright tests |

## Scope and limits

- The FedRAMP 20x baseline is a stub with placeholder indicators; the FedRAMP
  Rev5 sample is a 12-control subset. The vendored Rev5 Moderate profile is the
  only profile that is resolved.
- The Binder is not an authorization tool and does not produce an ATO.
- There is no eMASS, Archer, or Jira connection.

## License

MIT. See [LICENSE](LICENSE).
