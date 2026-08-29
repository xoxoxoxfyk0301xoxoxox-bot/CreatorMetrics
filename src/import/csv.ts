import { createHash } from "node:crypto";

export function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function decodeCsv(bytes: Uint8Array): string {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(3));
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { return new TextDecoder("shift_jis", { fatal: true }).decode(bytes); }
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = "", quoted = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') { field += '"'; index++; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"' && field.length === 0) quoted = true;
    else if (char === ",") { row.push(field); field = ""; }
    else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index++;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += char;
  }
  if (quoted) throw new Error("Malformed CSV: unterminated quoted field");
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.map((values) => values.map((value) => value.trim()));
}
