import { xmlEscape } from "./oscal";
import { zipStore } from "./zip";
import type { ControlView, ParityReport, ParitySample } from "./types";

function cell(column: string, row: number, value: string): string {
  const ref = `${column}${row}`;
  return `<c r="${ref}" t="inlineStr"><is><t>${xmlEscape(value)}</t></is></c>`;
}

function sheet(rows: string[][]): string {
  const body = rows
    .map((columns, index) => {
      const row = index + 1;
      const cells = columns.map((value, columnIndex) => cell(String.fromCharCode(65 + columnIndex), row, value)).join("");
      return `<row r="${row}">${cells}</row>`;
    })
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`;
}

export function renderWordXml(controls: ControlView[], title: string): string {
  const rows = controls
    .map((control) => {
      const evidence = control.evidence.map((item) => `${item.id} ${item.title} ${item.href}`).join("; ");
      return `<tr>
        <td>${xmlEscape(control.id)}</td>
        <td>${xmlEscape(control.title)}</td>
        <td>${xmlEscape(control.implementation)}</td>
        <td>${xmlEscape(control.responsibleRole)}</td>
        <td>${xmlEscape(evidence)}</td>
      </tr>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>${xmlEscape(title)} SSP</w:t></w:r></w:p>
    <w:tbl>
      <w:tr>
        <w:tc><w:p><w:r><w:t>Control</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>Title</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>Implementation</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>Responsible role</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>Evidence</w:t></w:r></w:p></w:tc>
      </w:tr>
      ${rows}
    </w:tbl>
  </w:body>
</w:document>`;
}

export function renderExcelSheets(controls: ControlView[], title: string): { controls: string; evidence: string } {
  const controlRows: string[][] = [
    [title],
    ["Control", "Title", "Family", "Implementation", "Responsible role", "Evidence"],
    ...controls.map((control) => [
      control.id,
      control.title,
      control.family,
      control.implementation,
      control.responsibleRole,
      control.evidence.map((item) => item.id).join(", "),
    ]),
  ];
  const evidenceRows: string[][] = [
    ["Evidence"],
    ["Evidence id", "Control", "Title", "Type", "Href"],
  ];
  for (const control of controls) {
    for (const item of control.evidence) {
      evidenceRows.push([item.id, control.id, item.title, item.type, item.href]);
    }
  }
  return { controls: sheet(controlRows), evidence: sheet(evidenceRows) };
}

export function packageDocx(wordXml: string): Buffer {
  return zipStore([
    {
      name: "[Content_Types].xml",
      data: `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`,
    },
    {
      name: "_rels/.rels",
      data: `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
    },
    { name: "word/document.xml", data: wordXml },
  ]);
}

export function packageXlsx(controlsSheet: string, evidenceSheet: string): Buffer {
  return zipStore([
    {
      name: "[Content_Types].xml",
      data: `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`,
    },
    {
      name: "_rels/.rels",
      data: `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`,
    },
    {
      name: "xl/workbook.xml",
      data: `<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="Controls" sheetId="1" r:id="rId1"/>
    <sheet name="Evidence" sheetId="2" r:id="rId2"/>
  </sheets>
</workbook>`,
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
</Relationships>`,
    },
    { name: "xl/worksheets/sheet1.xml", data: controlsSheet },
    { name: "xl/worksheets/sheet2.xml", data: evidenceSheet },
  ]);
}

function controlBlock(xml: string, oscalId: string): string {
  const match = xml.match(new RegExp(`<implemented-requirement control-id="${oscalId}">[\\s\\S]*?</implemented-requirement>`));
  return match?.[0] ?? "";
}

/** Controls sheet row whose column A holds this control id, or null when the sheet has none. */
function excelRowOf(xml: string, controlId: string): number | null {
  const id = xmlEscape(controlId);
  const pattern = new RegExp(`<c r="A(\\d+)" t="inlineStr"><is><t>${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}</t></is></c>`);
  const match = xml.match(pattern);
  return match ? Number(match[1]) : null;
}

function cellHas(xml: string, ref: string, value: string): boolean {
  const start = xml.indexOf(`<c r="${ref}"`);
  if (start < 0) return false;
  return xml.slice(start, start + 500).includes(xmlEscape(value));
}

function wordRowHas(xml: string, controlId: string, value: string): boolean {
  const rows = xml.split("<tr>").slice(1);
  const row = rows.find((item) => item.includes(`<td>${xmlEscape(controlId)}</td>`));
  return Boolean(row && value.length > 0 && row.includes(xmlEscape(value)));
}

export function spotCheckParity(args: {
  irHash: string;
  controls: ControlView[];
  oscalXml: string;
  wordXml: string;
  excelControlsXml: string;
}): ParityReport {
  const byId = new Map(args.controls.map((control) => [control.id, control]));
  const samples: ParitySample[] = [];

  const addImplementation = (controlId: string) => {
    const control = byId.get(controlId);
    if (!control) return;
    const row = excelRowOf(args.excelControlsXml, control.id);
    const block = controlBlock(args.oscalXml, control.oscalId);
    samples.push({
      field: `${control.id} · implementation`,
      ir: control.implementation,
      oscal: {
        label: `implemented-requirement ${control.oscalId} · description`,
        match: control.implementation.length > 0 && block.includes(xmlEscape(control.implementation)),
      },
      word: {
        label: `SSP table ${control.id} · Implementation`,
        match: wordRowHas(args.wordXml, control.id, control.implementation),
      },
      excel: {
        label: row ? `Controls!D${row}` : `Controls · no ${control.id} row`,
        cell: row ? `Controls!D${row}` : "",
        match: row != null && control.implementation.length > 0 && cellHas(args.excelControlsXml, `D${row}`, control.implementation),
      },
    });
  };

  addImplementation("AC-2");
  const ac2 = byId.get("AC-2");
  if (ac2) {
    const block = controlBlock(args.oscalXml, ac2.oscalId);
    const row = excelRowOf(args.excelControlsXml, ac2.id);
    samples.push({
      field: "AC-2 · responsibleRole",
      ir: ac2.responsibleRole,
      oscal: {
        label: "responsible-role @role-id",
        match: ac2.responsibleRoleId.length > 0 && block.includes(`role-id="${ac2.responsibleRoleId}"`),
      },
      word: {
        label: "SSP table AC-2 · Responsible role",
        match: wordRowHas(args.wordXml, "AC-2", ac2.responsibleRole),
      },
      excel: {
        label: row ? `Controls!E${row}` : "Controls · no AC-2 row",
        cell: row ? `Controls!E${row}` : "",
        match: row != null && ac2.responsibleRole.length > 0 && cellHas(args.excelControlsXml, `E${row}`, ac2.responsibleRole),
      },
    });
  }
  addImplementation("CM-6");

  const matched = samples.filter((sample) => sample.oscal.match && sample.word.match && sample.excel.match).length;
  return { irHash: args.irHash, sampled: samples.length, matched, samples };
}
