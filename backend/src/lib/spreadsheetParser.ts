import * as XLSX from "xlsx";

/**
 * Synchronous SheetJS parsing and rendering. This module is imported only by
 * spreadsheetParserChild.ts so attacker-controlled work never runs on the
 * shared backend event loop.
 */

/** Formatted display text for a cell (`w`), falling back to the raw value. */
function cellDisplayText(cell: XLSX.CellObject | undefined): string {
  if (!cell) return "";
  if (typeof cell.w === "string" && cell.w.length > 0) return cell.w;
  if (cell.v == null) return "";
  return String(cell.v);
}

/** Escape a cell value so it can't break the markdown table layout. */
function sanitizeCellText(value: string): string {
  return value.replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();
}

function renderSheet(sheetName: string, ws: XLSX.WorkSheet): string | null {
  const ref = ws["!ref"];
  if (!ref) return null;
  const range = XLSX.utils.decode_range(ref);

  // Map each merged range's top-left (anchor) address to its encoded range so we
  // can tag the anchor inline (e.g. `Amount ⟨merged B2:C2⟩`). The covered cells
  // stay blank, so the model never reads a covered address (e.g. B1 inside
  // A1:C1) as its own value; the tag tells it that the anchor spans the range.
  const mergeAnchors = new Map<string, string>();
  for (const merge of ws["!merges"] ?? []) {
    mergeAnchors.set(
      XLSX.utils.encode_cell(merge.s),
      XLSX.utils.encode_range(merge),
    );
  }

  // Build a trimmed grid: capture formatted text for every cell in the used
  // range, then drop trailing empty columns and fully empty rows.
  const rows: { rowNumber: number; cells: string[] }[] = [];
  let lastNonEmptyCol = -1;

  for (let row = range.s.r; row <= range.e.r; row++) {
    const cells: string[] = [];
    let rowHasContent = false;
    for (let col = range.s.c; col <= range.e.c; col++) {
      const address = XLSX.utils.encode_cell({ r: row, c: col });
      let text = sanitizeCellText(cellDisplayText(ws[address]));
      const mergeRange = mergeAnchors.get(address);
      if (mergeRange) {
        text = text
          ? `${text} ⟨merged ${mergeRange}⟩`
          : `⟨merged ${mergeRange}⟩`;
      }
      cells[col - range.s.c] = text;
      if (text) {
        rowHasContent = true;
        if (col - range.s.c > lastNonEmptyCol) {
          lastNonEmptyCol = col - range.s.c;
        }
      }
    }
    if (rowHasContent) rows.push({ rowNumber: row + 1, cells });
  }

  if (rows.length === 0 || lastNonEmptyCol < 0) return null;

  // Column-letter header, e.g. ["A", "B", "C"] for the used columns.
  const colLetters: string[] = [];
  for (let col = 0; col <= lastNonEmptyCol; col++) {
    colLetters.push(XLSX.utils.encode_col(range.s.c + col));
  }

  const headerRow = `| Row | ${colLetters.join(" | ")} |`;
  const separator = `| --- | ${colLetters.map(() => "---").join(" | ")} |`;
  const bodyRows = rows.map(({ rowNumber, cells }) => {
    const padded: string[] = [];
    for (let col = 0; col <= lastNonEmptyCol; col++) {
      padded.push(cells[col] ?? "");
    }
    return `| ${rowNumber} | ${padded.join(" | ")} |`;
  });

  const lines = [
    `## Sheet: ${sheetName}`,
    "",
    headerRow,
    separator,
    ...bodyRows,
  ];
  return lines.join("\n");
}

/**
 * Extract a spreadsheet as cell-addressed markdown for the LLM. Handles
 * `.xlsx`, `.xlsm`, and legacy `.xls` (SheetJS reads all three), preserving
 * Excel-formatted display values and citation-compatible cell addresses.
 */
export function spreadsheetToLLMTextSync(buffer: Buffer): string {
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const sheets: string[] = [];
  for (const sheetName of workbook.SheetNames) {
    const worksheet = workbook.Sheets[sheetName];
    if (!worksheet) continue;
    const rendered = renderSheet(sheetName, worksheet);
    if (rendered) sheets.push(rendered);
  }
  return sheets.join("\n\n").trim();
}
