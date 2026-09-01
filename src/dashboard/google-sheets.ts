import { google, type Auth, type sheets_v4 } from "googleapis";
import type { CommissionPaymentRecord, ContentMetricRecord, DailyMetricRecord, SalesMetricRecord, TransactionRecord } from "../types.js";
import type { DashboardDataSource, DashboardOutput, DashboardSink, RawDashboardData } from "./types.js";

const OUTPUT_SHEETS = ["Dashboard", "WeeklySummary", "TopContent"] as const;
const WEEKLY_HEADER = ["key", "weekStart", "weekEnd", "platform", "views", "likes", "comments", "replies", "reposts", "shares", "clicks", "orders", "grossSales", "commission", "postsPublished", "previousPeriodValue", "changeRate", "changeLabel", "overallQuality", "quality", "collectionStatus", "activityStatus", "comparisonStatus", "generatedAt"];
const TOP_HEADER = ["key", "periodType", "periodStart", "periodEnd", "platform", "rank", "contentId", "title", "publishedAt", "views", "likes", "comments", "replies", "reposts", "shares", "engagementRate", "quality", "generatedAt"];
const DASHBOARD_HEADER = ["媒体", "指標", "値", "表示", "データ品質", "対象期間", "生成日時"];
function q(name: string): string { return `'${name.replaceAll("'", "''")}'`; }
function number(value: unknown): number { const parsed = Number(value ?? 0); return Number.isFinite(parsed) ? parsed : 0; }
function nullableNumber(value: unknown): number | null { return value === "" || value === undefined || value === null ? null : number(value); }
function objects(values: unknown[][]): Record<string, unknown>[] {
  const [header = [], ...rows] = values;
  return rows.filter((row) => row.some((value) => value !== "")).map((row) => Object.fromEntries(header.map((name, index) => [String(name), row[index] ?? ""])));
}
function parseDaily(values: unknown[][]): DailyMetricRecord[] {
  const [header = [], ...rows] = values;
  const names = header.map(String);
  const index = (name: string) => names.indexOf(name);
  return rows.filter((row) => row.some((value) => value !== "")).map((row): DailyMetricRecord | null => {
    const jsonCell = row.find((value) => typeof value === "string" && value.trim().startsWith("{") && value.trim().endsWith("}"));
    if (typeof jsonCell !== "string") {
      // v0.0 legacy rows were key,date,platform,accountId,metric,value,dimensions,updatedAt.
      if (typeof row[0] === "string" && row[0].includes("|") && /^\d{4}-\d{2}-\d{2}$/.test(String(row[1] ?? ""))) {
        const value = Number(row[5]);
        if (!Number.isFinite(value) || !row[4]) return null;
        return { date: String(row[1]), platform: String(row[2]), accountId: String(row[3]), metrics: { [String(row[4])]: value }, collectedAt: String(row[7] ?? "") };
      }
      throw new Error("DailyMetrics metrics JSON column was not found");
    }
    let metrics: Record<string, number>;
    try { metrics = JSON.parse(jsonCell) as Record<string, number>; }
    catch { throw new Error("DailyMetrics metrics JSON is invalid"); }
    const accountCell = row[index("accountId")];
    const accountId = typeof accountCell === "string" && accountCell !== jsonCell ? accountCell : String(row.find((value, cellIndex) => cellIndex > 1 && value !== jsonCell && typeof value === "string" && value !== "") ?? "");
    return { date: String(row[index("date")] ?? row[0] ?? ""), platform: String(row[index("platform")] ?? row[1] ?? ""), accountId, metrics, collectedAt: String(row[index("collectedAt")] ?? row.at(-1) ?? "") };
  }).filter((row): row is DailyMetricRecord => row !== null);
}

export class GoogleSheetsDashboardStore implements DashboardDataSource, DashboardSink {
  private readonly sheets: sheets_v4.Sheets;
  constructor(auth: Auth.OAuth2Client, private readonly spreadsheetId: string) { this.sheets = google.sheets({ version: "v4", auth }); }

  async readRawData(): Promise<RawDashboardData> {
    const response = await this.sheets.spreadsheets.values.batchGet({ spreadsheetId: this.spreadsheetId, ranges: ["'DailyMetrics'!A:H", "'ContentMetrics'!A:Q", "'SalesMetrics'!A:Q", "'Transactions'!A:AA", "'CommissionPayments'!A:I", "'CollectionLog'!A:Z"] });
    const [dailyRows = [], contentRows = [], salesRows = [], transactionRows = [], paymentRows = [], logRows = []] = (response.data.valueRanges ?? []).map((range) => range.values ?? []);
    const daily = parseDaily(dailyRows);
    const content: ContentMetricRecord[] = objects(contentRows).map((row) => ({ date: String(row.date), platform: String(row.platform), contentId: String(row.contentId), contentType: String(row.contentType), title: String(row.title), publishedAt: String(row.publishedAt), views: number(row.views), estimatedMinutesWatched: number(row.estimatedMinutesWatched), likes: number(row.likes), comments: number(row.comments), shares: number(row.shares), averageViewDuration: number(row.averageViewDuration), collectedAt: String(row.collectedAt), ...(row.replies !== "" ? { replies: number(row.replies) } : {}), ...(row.reposts !== "" ? { reposts: number(row.reposts) } : {}), ...(row.quotes !== "" ? { quotes: number(row.quotes) } : {}), ...(row.engagementRate !== "" ? { engagementRate: number(row.engagementRate) } : {}) }));
    const sales: SalesMetricRecord[] = objects(salesRows).map((row) => ({ key: String(row.key), date: String(row.date), yearMonth: String(row.yearMonth), periodMonth: row.periodMonth ? String(row.periodMonth) : null, platform: String(row.platform), source: String(row.source), shopName: String(row.shopName), grossSales: number(row.grossSales), fees: number(row.fees), netSalesBeforeTransferFee: number(row.netSalesBeforeTransferFee), transferFees: number(row.transferFees), netSales: number(row.netSales), commission: number(row.commission), clicks: nullableNumber(row.clicks), orders: nullableNumber(row.orders), conversionRate: nullableNumber(row.conversionRate), collectedAt: String(row.collectedAt) }));
    const transactions: TransactionRecord[] = objects(transactionRows).map((row) => ({ key: String(row.key), transactionDate: String(row.transactionDate), periodMonth: row.periodMonth ? String(row.periodMonth) : null, platform: String(row.platform), source: String(row.source), transactionId: String(row.transactionId), paymentType: String(row.paymentType), paymentMethod: String(row.paymentMethod), contentType: String(row.contentType), contentName: String(row.contentName), grossSales: number(row.grossSales), taxRate: number(row.taxRate), salesBeforeTax: number(row.salesBeforeTax), taxAmount: number(row.taxAmount), pointsUsed: number(row.pointsUsed), commission: number(row.commission), commissionRate: number(row.commissionRate), genre: String(row.genre), shopName: String(row.shopName), itemName: String(row.itemName), rawStatus: String(row.rawStatus), orderStatus: String(row.orderStatus) as TransactionRecord["orderStatus"], linkType: String(row.linkType), deviceType: String(row.deviceType), measurementId: String(row.measurementId), collectedAt: String(row.collectedAt), sourceFileHash: String(row.sourceFileHash) }));
    const payments: CommissionPaymentRecord[] = objects(paymentRows).map((row) => ({ key: String(row.key), yearMonth: String(row.yearMonth), platform: String(row.platform), source: String(row.source), rakutenPoints: number(row.rakutenPoints), rakutenCash: number(row.rakutenCash), bankTransfer: number(row.bankTransfer), totalPaid: number(row.totalPaid), collectedAt: String(row.collectedAt) }));
    const parsedLogs=objects(logRows);
    const importActivity = parsedLogs.filter((row) => row.source && row.finishedAt).map((row) => ({ platform: String(row.platform), source: String(row.source), status: String(row.status), finishedAt: String(row.finishedAt) }));
    const collectionActivity = parsedLogs.filter((row) => row.date && row.platform && !row.source && row.finishedAt).map((row) => ({ date:String(row.date),platform:String(row.platform),status:String(row.status),dailyMetricsCount:number(row.dailyMetricsCount),contentMetricsCount:number(row.contentMetricsCount),writtenDaily:number(row.writtenDaily),writtenContent:number(row.writtenContent),reason:String(row.reason),errorCode:String(row.errorCode),finishedAt:String(row.finishedAt) }));
    return { daily, content, sales, transactions, payments, importActivity, collectionActivity };
  }

  async writeDashboard(output: DashboardOutput): Promise<void> {
    await this.ensureOutputSheets();
    await this.sheets.spreadsheets.values.batchClear({ spreadsheetId: this.spreadsheetId, requestBody: { ranges: OUTPUT_SHEETS.map((sheet) => `${q(sheet)}!A:Z`) } });
    const dashboardValues: unknown[][] = [["Creator Metrics Dashboard", "", "", "", "", "", ""], ["最終更新", output.dashboard[0]?.display ?? "", "", "", "", "", ""], [], DASHBOARD_HEADER];
    let previousSection = "";
    for (const row of output.dashboard.filter((item) => item.metric !== "最終更新")) {
      if (previousSection && previousSection !== row.section) dashboardValues.push([]);
      dashboardValues.push([row.section, row.metric, row.value ?? "", row.display, row.quality, row.period, row.generatedAt]);
      previousSection = row.section;
    }
    const weeklyValues = [WEEKLY_HEADER, ...output.weekly.map((row) => [row.key, row.weekStart, row.weekEnd, row.platform, row.views ?? "", row.likes ?? "", row.comments ?? "", row.replies ?? "", row.reposts ?? "", row.shares ?? "", row.clicks ?? "", row.orders ?? "", row.grossSales ?? "", row.commission ?? "", row.postsPublished ?? "", row.previousPeriodValue ?? "", row.changeRate ?? "", row.changeLabel, row.overallQuality, JSON.stringify(row.quality),row.collectionStatus,row.activityStatus,row.comparisonStatus,row.generatedAt])];
    const topValues = [TOP_HEADER, ...output.topContent.map((row) => [row.key, row.periodType, row.periodStart, row.periodEnd, row.platform, row.rank, row.contentId, row.title, row.publishedAt, row.views, row.likes, row.comments ?? "", row.replies ?? "", row.reposts ?? "", row.shares, row.engagementRate ?? "", row.quality, row.generatedAt])];
    await this.sheets.spreadsheets.values.batchUpdate({ spreadsheetId: this.spreadsheetId, requestBody: { valueInputOption: "RAW", data: [{ range: "'Dashboard'!A1", values: dashboardValues }, { range: "'WeeklySummary'!A1", values: weeklyValues }, { range: "'TopContent'!A1", values: topValues }] } });
    await this.formatOutputs(dashboardValues.length, weeklyValues.length, topValues.length);
  }

  private async ensureOutputSheets(): Promise<void> {
    const metadata = await this.sheets.spreadsheets.get({ spreadsheetId: this.spreadsheetId });
    const existing = new Set(metadata.data.sheets?.map((sheet) => sheet.properties?.title));
    const requests = OUTPUT_SHEETS.filter((title) => !existing.has(title)).map((title) => ({ addSheet: { properties: { title } } }));
    if (requests.length) await this.sheets.spreadsheets.batchUpdate({ spreadsheetId: this.spreadsheetId, requestBody: { requests } });
  }

  private async formatOutputs(dashboardRows: number, weeklyRows: number, topRows: number): Promise<void> {
    const metadata = await this.sheets.spreadsheets.get({ spreadsheetId: this.spreadsheetId });
    const ids = Object.fromEntries((metadata.data.sheets ?? []).map((sheet) => [sheet.properties?.title ?? "", sheet.properties?.sheetId ?? 0]));
    const requests: sheets_v4.Schema$Request[] = [];
    const dashboardId = ids.Dashboard!, weeklyId = ids.WeeklySummary!, topId = ids.TopContent!;
    const dashboardSheet = metadata.data.sheets?.find((sheet) => sheet.properties?.sheetId === dashboardId);
    const titleMerged = dashboardSheet?.merges?.some((range) => range.startRowIndex === 0 && range.endRowIndex === 1 && range.startColumnIndex === 0 && range.endColumnIndex === 7);
    if (!titleMerged) requests.push({ mergeCells: { range: { sheetId: dashboardId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 7 }, mergeType: "MERGE_ALL" } });
    for (const [sheetId, headerRow, columns] of [[dashboardId, 3, 7], [weeklyId, 0, WEEKLY_HEADER.length], [topId, 0, TOP_HEADER.length]] as const) {
      requests.push({ repeatCell: { range: { sheetId, startRowIndex: headerRow, endRowIndex: headerRow + 1, startColumnIndex: 0, endColumnIndex: columns }, cell: { userEnteredFormat: { backgroundColor: { red: 0.9, green: 0.9, blue: 0.9 }, textFormat: { bold: true }, horizontalAlignment: "CENTER" } }, fields: "userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)" } }, { updateSheetProperties: { properties: { sheetId, gridProperties: { frozenRowCount: headerRow + 1 } }, fields: "gridProperties.frozenRowCount" } });
    }
    requests.push({ repeatCell: { range: { sheetId: dashboardId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 7 }, cell: { userEnteredFormat: { backgroundColor: { red: 0.2, green: 0.45, blue: 0.7 }, textFormat: { bold: true, fontSize: 16, foregroundColor: { red: 1, green: 1, blue: 1 } }, horizontalAlignment: "CENTER" } }, fields: "userEnteredFormat" } }, { repeatCell: { range: { sheetId: dashboardId, startRowIndex: 4, endRowIndex: dashboardRows, startColumnIndex: 0, endColumnIndex: 1 }, cell: { userEnteredFormat: { textFormat: { bold: true } } }, fields: "userEnteredFormat.textFormat.bold" } });
    const widths = [[dashboardId, [120, 170, 100, 130, 150, 210, 190]], [weeklyId, [180, 100, 100, 130]], [topId, [180, 90, 100, 100, 100, 60, 150, 260, 170]]] as const;
    for (const [sheetId, values] of widths) values.forEach((pixelSize, index) => requests.push({ updateDimensionProperties: { range: { sheetId, dimension: "COLUMNS", startIndex: index, endIndex: index + 1 }, properties: { pixelSize }, fields: "pixelSize" } }));
    requests.push({ repeatCell: { range: { sheetId: weeklyId, startRowIndex: 1, endRowIndex: weeklyRows, startColumnIndex: 12, endColumnIndex: 14 }, cell: { userEnteredFormat: { numberFormat: { type: "CURRENCY", pattern: "¥#,##0" } } }, fields: "userEnteredFormat.numberFormat" } }, { repeatCell: { range: { sheetId: weeklyId, startRowIndex: 1, endRowIndex: weeklyRows, startColumnIndex: 16, endColumnIndex: 17 }, cell: { userEnteredFormat: { numberFormat: { type: "PERCENT", pattern: "0.0%" } } }, fields: "userEnteredFormat.numberFormat" } }, { repeatCell: { range: { sheetId: topId, startRowIndex: 1, endRowIndex: topRows, startColumnIndex: 15, endColumnIndex: 16 }, cell: { userEnteredFormat: { numberFormat: { type: "PERCENT", pattern: "0.0%" } } }, fields: "userEnteredFormat.numberFormat" } });
    const formats = metadata.data.sheets?.find((sheet) => sheet.properties?.sheetId === dashboardId)?.conditionalFormats ?? [];
    for (let index = formats.length - 1; index >= 0; index--) requests.push({ deleteConditionalFormatRule: { sheetId: dashboardId, index } });
    const addRule = (formula: string, color: { red: number; green: number; blue: number }) => requests.push({ addConditionalFormatRule: { index: 0, rule: { ranges: [{ sheetId: dashboardId, startRowIndex: 4, endRowIndex: dashboardRows, startColumnIndex: 3, endColumnIndex: 4 }], booleanRule: { condition: { type: "CUSTOM_FORMULA", values: [{ userEnteredValue: formula }] }, format: { textFormat: { foregroundColor: color, bold: true } } } } } });
    addRule('=LEFT($D5,1)="+"', { red: 0.1, green: 0.55, blue: 0.2 }); addRule('=LEFT($D5,1)="-"', { red: 0.75, green: 0.15, blue: 0.15 }); addRule('=$D5="NEW"', { red: 0.1, green: 0.35, blue: 0.75 }); addRule('=$D5="比較不能"', { red: 0.45, green: 0.45, blue: 0.45 });
    await this.sheets.spreadsheets.batchUpdate({ spreadsheetId: this.spreadsheetId, requestBody: { requests } });
  }
}
