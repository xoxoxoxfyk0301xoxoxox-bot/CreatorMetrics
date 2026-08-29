import { google, type Auth, type sheets_v4 } from "googleapis";
import type { CollectionLogRecord, CommissionPaymentRecord, ContentMetricRecord, DailyMetricRecord, ImportLogRecord, ImportStore, MetricsStore, SalesMetricRecord, TransactionRecord, UpsertResult } from "../types.js";

const DAILY_HEADER = ["date", "platform", "accountId", "metrics", "collectedAt"];
const CONTENT_HEADER = ["date", "platform", "contentId", "contentType", "title", "publishedAt", "views", "estimatedMinutesWatched", "likes", "comments", "shares", "averageViewDuration", "collectedAt", "replies", "reposts", "quotes", "engagementRate"];
const LOG_HEADER = ["runId", "collectedAt", "date", "platform", "status", "dailyMetricsCount", "contentMetricsCount", "writtenDaily", "writtenContent", "durationMs", "reason", "error", "recordsWritten", "errorCode", "errorMessage", "startedAt", "finishedAt", "source", "filename", "fileHash", "rowsRead", "rowsWritten", "rowsUpdated", "rowsSkipped", "unknownColumns", "importErrorMessage"];
const SALES_HEADER = ["key", "date", "yearMonth", "periodMonth", "platform", "source", "shopName", "grossSales", "fees", "netSalesBeforeTransferFee", "transferFees", "netSales", "commission", "clicks", "orders", "conversionRate", "collectedAt"];
const TRANSACTION_HEADER = ["key", "transactionDate", "periodMonth", "platform", "source", "transactionId", "paymentType", "paymentMethod", "contentType", "contentName", "grossSales", "taxRate", "salesBeforeTax", "taxAmount", "pointsUsed", "commission", "commissionRate", "genre", "shopName", "itemName", "rawStatus", "orderStatus", "linkType", "deviceType", "measurementId", "collectedAt", "sourceFileHash"];
const PAYMENT_HEADER = ["key", "yearMonth", "platform", "source", "rakutenPoints", "rakutenCash", "bankTransfer", "totalPaid", "collectedAt"];

export function dailyMetricKey(record: Pick<DailyMetricRecord, "date" | "platform" | "accountId">): string { return [record.date, record.platform, record.accountId].join("|"); }
export function contentMetricKey(record: Pick<ContentMetricRecord, "date" | "platform" | "contentId">): string { return [record.date, record.platform, record.contentId].join("|"); }
function quoteSheet(name: string): string { return `'${name.replaceAll("'", "''")}'`; }
function columnName(column: number): string { let name = ""; while (column > 0) { column--; name = String.fromCharCode(65 + column % 26) + name; column = Math.floor(column / 26); } return name; }

export class GoogleSheetsStore implements MetricsStore, ImportStore {
  private readonly sheets: sheets_v4.Sheets;
  constructor(auth: Auth.OAuth2Client, private readonly spreadsheetId: string, private readonly metricsSheet: string, private readonly logSheet: string, private readonly contentSheet = "ContentMetrics") {
    this.sheets = google.sheets({ version: "v4", auth });
  }

  async ensureSheets(): Promise<void> {
    await Promise.all([this.ensureSheet(this.metricsSheet, DAILY_HEADER), this.ensureSheet(this.logSheet, LOG_HEADER)]);
  }

  async ensureImportSheets(): Promise<void> {
    await Promise.all([this.ensureSheet("SalesMetrics", SALES_HEADER), this.ensureSheet("Transactions", TRANSACTION_HEADER), this.ensureSheet("CommissionPayments", PAYMENT_HEADER), this.ensureSheet(this.logSheet, LOG_HEADER)]);
  }

  private async ensureSheet(sheet: string, header: string[]): Promise<void> {
    const metadata = await this.sheets.spreadsheets.get({ spreadsheetId: this.spreadsheetId });
    const exists = metadata.data.sheets?.some((item) => item.properties?.title === sheet);
    if (!exists) await this.sheets.spreadsheets.batchUpdate({ spreadsheetId: this.spreadsheetId, requestBody: { requests: [{ addSheet: { properties: { title: sheet } } }] } });
    const range = `${quoteSheet(sheet)}!1:1`;
    const current = await this.sheets.spreadsheets.values.get({ spreadsheetId: this.spreadsheetId, range });
    const currentHeader = current.data.values?.[0]?.map(String) ?? [];
    if (JSON.stringify(currentHeader) !== JSON.stringify(header)) await this.sheets.spreadsheets.values.update({
      spreadsheetId: this.spreadsheetId, range: `${quoteSheet(sheet)}!A1`, valueInputOption: "RAW", requestBody: { values: [header] }
    });
  }

  async upsertDailyMetrics(records: DailyMetricRecord[]): Promise<number> {
    if (!records.length) return 0;
    await this.ensureSheet(this.metricsSheet, DAILY_HEADER);
    return this.upsertRows(this.metricsSheet, 5, records.map((record) => ({
      key: dailyMetricKey(record), values: [record.date, record.platform, record.accountId, JSON.stringify(record.metrics), record.collectedAt]
    })), (row) => [row[0], row[1], row[2]].join("|"));
  }

  async upsertContentMetrics(records: ContentMetricRecord[]): Promise<number> {
    if (!records.length) return 0;
    await this.ensureSheet(this.contentSheet, CONTENT_HEADER);
    return this.upsertRows(this.contentSheet, 17, records.map((record) => ({
      key: contentMetricKey(record),
      values: [record.date, record.platform, record.contentId, record.contentType, record.title, record.publishedAt, record.views, record.estimatedMinutesWatched, record.likes, record.comments, record.shares, record.averageViewDuration, record.collectedAt, record.replies ?? "", record.reposts ?? "", record.quotes ?? "", record.engagementRate ?? ""]
    })), (row) => [row[0], row[1], row[2]].join("|"));
  }

  private async upsertRows(sheet: string, columnCount: number, records: { key: string; values: unknown[] }[], keyFromRow: (row: unknown[]) => string): Promise<number> {
    const endColumn = columnName(columnCount);
    const response = await this.sheets.spreadsheets.values.get({ spreadsheetId: this.spreadsheetId, range: `${quoteSheet(sheet)}!A2:${endColumn}` });
    const rowByKey = new Map((response.data.values ?? []).map((row, index) => [keyFromRow(row), index + 2]));
    const updates: sheets_v4.Schema$ValueRange[] = [];
    const appends: unknown[][] = [];
    for (const record of records) {
      const rowNumber = rowByKey.get(record.key);
      if (rowNumber) updates.push({ range: `${quoteSheet(sheet)}!A${rowNumber}:${endColumn}${rowNumber}`, values: [record.values] });
      else appends.push(record.values);
    }
    if (updates.length) await this.sheets.spreadsheets.values.batchUpdate({ spreadsheetId: this.spreadsheetId, requestBody: { valueInputOption: "RAW", data: updates } });
    if (appends.length) await this.sheets.spreadsheets.values.append({ spreadsheetId: this.spreadsheetId, range: `${quoteSheet(sheet)}!A:${endColumn}`, valueInputOption: "RAW", insertDataOption: "INSERT_ROWS", requestBody: { values: appends } });
    return records.length;
  }

  async appendLog(log: CollectionLogRecord): Promise<void> {
    await this.sheets.spreadsheets.values.append({ spreadsheetId: this.spreadsheetId, range: `${quoteSheet(this.logSheet)}!A:Q`, valueInputOption: "RAW", insertDataOption: "INSERT_ROWS", requestBody: {
      values: [[log.runId, log.collectedAt, log.date, log.platform, log.status, log.dailyMetrics, log.contentMetrics, log.writtenDaily, log.writtenContent, log.durationMs, log.reason, log.error, log.recordsWritten, log.errorCode, log.errorMessage, log.startedAt, log.finishedAt]]
    } });
  }

  async hasImportedFile(fileHash: string): Promise<boolean> {
    const response = await this.sheets.spreadsheets.values.get({ spreadsheetId: this.spreadsheetId, range: `${quoteSheet(this.logSheet)}!E2:T` });
    return (response.data.values ?? []).some((row) => row[0] === "success" && row[15] === fileHash);
  }

  async upsertSalesMetrics(records: SalesMetricRecord[]): Promise<UpsertResult> {
    return this.upsertImportRows("SalesMetrics", SALES_HEADER.length, records.map((record) => ({ key: record.key, values: [record.key, record.date, record.yearMonth, record.periodMonth ?? "", record.platform, record.source, record.shopName, record.grossSales, record.fees, record.netSalesBeforeTransferFee, record.transferFees, record.netSales, record.commission, record.clicks ?? "", record.orders ?? "", record.conversionRate ?? "", record.collectedAt] })));
  }

  async upsertTransactions(records: TransactionRecord[]): Promise<UpsertResult> {
    return this.upsertImportRows("Transactions", TRANSACTION_HEADER.length, records.map((record) => ({ key: record.key, values: [record.key, record.transactionDate, record.periodMonth ?? "", record.platform, record.source, record.transactionId, record.paymentType, record.paymentMethod, record.contentType, record.contentName, record.grossSales, record.taxRate, record.salesBeforeTax, record.taxAmount, record.pointsUsed, record.commission, record.commissionRate, record.genre, record.shopName, record.itemName, record.rawStatus, record.orderStatus, record.linkType, record.deviceType, record.measurementId, record.collectedAt, record.sourceFileHash] })));
  }

  async upsertCommissionPayments(records: CommissionPaymentRecord[]): Promise<UpsertResult> {
    return this.upsertImportRows("CommissionPayments", PAYMENT_HEADER.length, records.map((record) => ({ key: record.key, values: [record.key, record.yearMonth, record.platform, record.source, record.rakutenPoints, record.rakutenCash, record.bankTransfer, record.totalPaid, record.collectedAt] })));
  }

  private async upsertImportRows(sheet: string, columnCount: number, records: { key: string; values: unknown[] }[]): Promise<UpsertResult> {
    if (!records.length) return { written: 0, updated: 0 };
    await this.ensureSheet(sheet, sheet === "SalesMetrics" ? SALES_HEADER : sheet === "Transactions" ? TRANSACTION_HEADER : PAYMENT_HEADER);
    const endColumn = columnName(columnCount);
    const response = await this.sheets.spreadsheets.values.get({ spreadsheetId: this.spreadsheetId, range: `${quoteSheet(sheet)}!A2:${endColumn}` });
    const rowByKey = new Map((response.data.values ?? []).map((row, index) => [String(row[0] ?? ""), index + 2]));
    const updates: sheets_v4.Schema$ValueRange[] = [], appends: unknown[][] = [];
    for (const record of records) {
      const rowNumber = rowByKey.get(record.key);
      if (rowNumber) updates.push({ range: `${quoteSheet(sheet)}!A${rowNumber}:${endColumn}${rowNumber}`, values: [record.values] });
      else { appends.push(record.values); rowByKey.set(record.key, -1); }
    }
    if (updates.length) await this.sheets.spreadsheets.values.batchUpdate({ spreadsheetId: this.spreadsheetId, requestBody: { valueInputOption: "RAW", data: updates } });
    if (appends.length) await this.sheets.spreadsheets.values.append({ spreadsheetId: this.spreadsheetId, range: `${quoteSheet(sheet)}!A:${endColumn}`, valueInputOption: "RAW", insertDataOption: "INSERT_ROWS", requestBody: { values: appends } });
    return { written: appends.length, updated: updates.length };
  }

  async appendImportLog(log: ImportLogRecord): Promise<void> {
    await this.ensureSheet(this.logSheet, LOG_HEADER);
    await this.sheets.spreadsheets.values.append({ spreadsheetId: this.spreadsheetId, range: `${quoteSheet(this.logSheet)}!A:Z`, valueInputOption: "RAW", insertDataOption: "INSERT_ROWS", requestBody: { values: [["", "", "", log.platform, log.status, "", "", "", "", "", "", "", log.rowsWritten + log.rowsUpdated, "", "", log.startedAt, log.finishedAt, log.source, log.filename, log.fileHash, log.rowsRead, log.rowsWritten, log.rowsUpdated, log.rowsSkipped, log.unknownColumns.join(","), log.errorMessage]] } });
  }
}
