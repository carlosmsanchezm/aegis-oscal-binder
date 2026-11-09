# Upload samples

Upload OSCAL accepts JSON or XML whose root is `system-security-plan`. The binder builds the workspace name, boundary id, and in-scope controls from `system-characteristics` and `control-implementation`.

A file whose root is only `component-definition` is rejected by design. The error is `INGEST_REJECTED`: `OSCAL JSON must contain a system-security-plan object.` The binder does not build a package map from a component definition.

| File | Catalog to select | What the map shows |
| --- | --- | --- |
| `ssp-rev5.json` | FedRAMP Rev5 (`fedramp-rev5-subset@2026.09`) | Boundary `bnd-upload-rev5`. The 12-control FedRAMP Rev5 subset: AC-2, AC-3, AC-6, AU-2, AU-6, CM-2, CM-6, IA-2, IA-5, SC-7, SC-8, SI-2. Not the full FedRAMP Rev5 baseline. AU-2 has no evidence, so the gate stays FAIL (1 of 12). The Level 1 map draws catalog related links on hover or select (2px at rest, 2.5px on hover). A family with more than 24 links draws one arc per other family. PASS 8 of 8 is only `fixtures/audit/package-retest.json`. This sample is FAIL 1 of 12. Completeness is a status, not an edge sink. |
| `ssp-20x.json` | FedRAMP 20x (`fedramp-20x-subset@2026.09`) | Boundary `bnd-upload-20x`. One stub control, `KSI-IAM`. Not the official 20x baseline. |
| `controls.csv` | Either catalog | Best-effort CSV merge (N13). Not the OSCAL package path. |

The same bytes are served from the running app:

- `/samples/sample-oscal-ssp-rev5.json`
- `/samples/sample-oscal-ssp-20x.json`
- `/samples/sample-controls.csv`

Keep each public file identical to the fixture in this directory. N11: select FedRAMP Rev5, then upload the Rev5 sample.

`public/samples/sample-oscal-ssp-rev5-moderate.json` is a separate synthetic SSP. Its `import-profile` href is `fixtures/rev5/fedramp-rev5-moderate-profile.json`. It is served at `/samples/sample-oscal-ssp-rev5-moderate.json` and is not linked from the empty workspace. Select FedRAMP Rev5 and upload that file. Blank profile controls count incomplete (322 of 323). The 12-control sample stays 1 of 12.

`m2-import-problems.json` is a synthetic SSP for the import problem report. Select FedRAMP Rev5. The file omits `metadata.title`, names control `zz-9`, uses statement ids that are not CM-6 parts, and points at a role, component, and resource that are not in the file. Upload is rejected. The loaded package is not replaced.
