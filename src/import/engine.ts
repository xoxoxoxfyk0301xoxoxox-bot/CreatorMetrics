import type { ImportLogRecord, ImportStore, Platform } from "../types.js";
import type { FileSource, ImportFile } from "./file-source.js";
import { decodeCsv, parseCsv, sha256 } from "./csv.js";
import { parseKnownCsv } from "./parsers.js";

export interface ImportSummary { filename: string; platform: Platform | "unknown"; source: string; status: "success" | "failed" | "skipped"; rowsRead: number; rowsWritten: number; rowsUpdated: number; rowsSkipped: number; unknownColumns: string[]; errorMessage: string }

export class CsvImportEngine {
  constructor(private readonly source: FileSource, private readonly store: ImportStore) {}
  async run(): Promise<ImportSummary[]> {
    await this.store.ensureImportSheets();
    const files = await this.source.listFiles();
    const results: ImportSummary[] = [];
    for (const file of files) results.push(await this.importFile(file));
    return results;
  }
  private async importFile(file: ImportFile): Promise<ImportSummary> {
    const startedAt = new Date().toISOString(), fileHash = sha256(file.bytes);
    let platform: Platform | "unknown" = "unknown", source = "unknown";
    try {
      if (await this.store.hasImportedFile(fileHash)) {
        const summary: ImportSummary = { filename: file.filename, platform, source, status: "skipped", rowsRead: 0, rowsWritten: 0, rowsUpdated: 0, rowsSkipped: 1, unknownColumns: [], errorMessage: "" };
        await this.log({ ...summary, fileHash, startedAt, finishedAt: new Date().toISOString() });
        return summary;
      }
      const parsed = parseKnownCsv(parseCsv(decodeCsv(file.bytes)), new Date().toISOString(), fileHash);
      platform = parsed.platform; source = parsed.source;
      if (parsed.unknownColumns.length) throw new Error(`Unknown CSV columns: ${parsed.unknownColumns.join(", ")}`);
      const results = await Promise.all([this.store.upsertSalesMetrics(parsed.sales), this.store.upsertTransactions(parsed.transactions), this.store.upsertCommissionPayments(parsed.payments)]);
      const rowsWritten = results.reduce((sum, value) => sum + value.written, 0), rowsUpdated = results.reduce((sum, value) => sum + value.updated, 0);
      const summary: ImportSummary = { filename: file.filename, platform, source, status: "success", rowsRead: parsed.rowsRead, rowsWritten, rowsUpdated, rowsSkipped: parsed.rowsSkipped, unknownColumns: [], errorMessage: "" };
      await this.log({ ...summary, fileHash, startedAt, finishedAt: new Date().toISOString() });
      return summary;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const summary: ImportSummary = { filename: file.filename, platform, source, status: "failed", rowsRead: 0, rowsWritten: 0, rowsUpdated: 0, rowsSkipped: 0, unknownColumns: errorMessage.startsWith("Unknown CSV columns: ") ? errorMessage.slice(21).split(", ") : [], errorMessage };
      await this.log({ ...summary, fileHash, startedAt, finishedAt: new Date().toISOString() });
      return summary;
    }
  }
  private async log(value: ImportSummary & { fileHash: string; startedAt: string; finishedAt: string }): Promise<void> {
    const record: ImportLogRecord = { platform: value.platform, source: value.source, filename: value.filename, fileHash: value.fileHash, status: value.status, rowsRead: value.rowsRead, rowsWritten: value.rowsWritten, rowsUpdated: value.rowsUpdated, rowsSkipped: value.rowsSkipped, unknownColumns: value.unknownColumns, errorMessage: value.errorMessage, startedAt: value.startedAt, finishedAt: value.finishedAt };
    await this.store.appendImportLog(record);
  }
}
