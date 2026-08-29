import { readFile } from "node:fs/promises";
import { decodeCsv, parseCsv } from "../import/csv.js";
import type { ImportCandidate } from "./service.js";

export async function readPostCandidates(path: string): Promise<ImportCandidate[]> {
  const text = decodeCsv(await readFile(path));
  if (path.toLowerCase().endsWith(".json") || text.trimStart().startsWith("[")) {
    const parsed: unknown = JSON.parse(text.replace(/^\uFEFF/, ""));
    if (!Array.isArray(parsed)) throw new Error("JSON must contain an array");
    return parsed.map((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Each JSON item must be an object");
      const item = value as Record<string, unknown>;
      const unknown = Object.keys(item).filter((key) => !["content", "scheduledAt", "notes"].includes(key));
      if (unknown.length) throw new Error(`Unknown JSON fields: ${unknown.join(",")}`);
      if (typeof item.content !== "string" || (item.scheduledAt !== undefined && typeof item.scheduledAt !== "string") || (item.notes !== undefined && typeof item.notes !== "string")) throw new Error("JSON fields must be strings");
      return { content: item.content, scheduledAt: item.scheduledAt ?? "", notes: item.notes ?? "" };
    });
  }
  const rows = parseCsv(text);
  const header = rows[0] ?? [], expected = ["content", "scheduledAt", "notes"];
  if (JSON.stringify(header) !== JSON.stringify(expected)) throw new Error(`CSV header must be: ${expected.join(",")}`);
  return rows.slice(1).filter((row) => row.some(Boolean)).map((row) => ({ content: row[0] ?? "", scheduledAt: row[1] ?? "", notes: row[2] ?? "" }));
}
