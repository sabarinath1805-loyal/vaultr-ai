import * as XLSX from "xlsx";

export function validSpreadsheetBuffer(
  bookType: "xlsx" | "xlsm" | "biff8" = "xlsx",
): Buffer {
  const workbook = XLSX.utils.book_new();
  const firstSheet = XLSX.utils.aoa_to_sheet([
    ["Budget|FY26", null, null],
    ["Total", null, null],
    ["Merged", null, null],
    ["Notes", "line|one\nline two"],
  ]);
  firstSheet.B1 = { t: "n", v: 46_082, z: "m/d/yy" };
  firstSheet.B2 = { t: "n", v: 1_200, z: "$#,##0" };
  firstSheet.C2 = {
    t: "n",
    v: 1_200,
    f: "SUM(1000,200)",
    z: "$#,##0",
  };
  firstSheet["!merges"] = [{ s: { r: 2, c: 0 }, e: { r: 2, c: 1 } }];
  XLSX.utils.book_append_sheet(workbook, firstSheet, "Q1 | Budget");
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([["Second"], ["value|with\nnewline"]]),
    "Notes",
  );

  return XLSX.write(workbook, { bookType, type: "buffer" }) as Buffer;
}
