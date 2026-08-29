import { google, type Auth, type sheets_v4 } from "googleapis";
import type { DashboardOutput, DashboardRow, DataQuality, TopContentRecord, WeeklySummaryRecord } from "../dashboard/types.js";
import type { ReportDocument, ReportSink, ReportSource } from "./types.js";

const SHEET = "Report";
function number(value: unknown): number { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : 0; }
function nullable(value: unknown): number | null { return value === "" || value === undefined || value === null ? null : number(value); }
function objects(values: unknown[][]): Record<string, unknown>[] { const [header = [], ...rows] = values; return rows.filter((row) => row.some((value) => value !== "")).map((row) => Object.fromEntries(header.map((name, index) => [String(name), row[index] ?? ""]))); }

export class GoogleSheetsReportStore implements ReportSource, ReportSink {
  private readonly sheets: sheets_v4.Sheets;
  constructor(auth: Auth.OAuth2Client, private readonly spreadsheetId: string) { this.sheets = google.sheets({ version: "v4", auth }); }
  async readDashboardOutput(): Promise<DashboardOutput> {
    const response = await this.sheets.spreadsheets.values.batchGet({ spreadsheetId: this.spreadsheetId, ranges: ["'Dashboard'!A4:G", "'WeeklySummary'!A:U", "'TopContent'!A:R"] });
    const [dashboardValues = [], weeklyValues = [], topValues = []] = (response.data.valueRanges ?? []).map((range) => range.values ?? []);
    const dashboard: DashboardRow[] = objects(dashboardValues).map((row) => ({ section: String(row["媒体"]), metric: String(row["指標"]), value: nullable(row["値"]), display: String(row["表示"]), quality: String(row["データ品質"]) as DataQuality, period: String(row["対象期間"]), generatedAt: String(row["生成日時"]) }));
    const weekly: WeeklySummaryRecord[] = objects(weeklyValues).map((row) => ({ key: String(row.key), weekStart: String(row.weekStart), weekEnd: String(row.weekEnd), platform: String(row.platform), views: nullable(row.views), likes: nullable(row.likes), comments: nullable(row.comments), replies: nullable(row.replies), reposts: nullable(row.reposts), shares: nullable(row.shares), clicks: nullable(row.clicks), orders: nullable(row.orders), grossSales: nullable(row.grossSales), commission: nullable(row.commission), postsPublished: nullable(row.postsPublished), previousPeriodValue: nullable(row.previousPeriodValue), changeRate: nullable(row.changeRate), changeLabel: String(row.changeLabel), overallQuality: String(row.overallQuality) as DataQuality, quality: JSON.parse(String(row.quality || "{}")) as Record<string, DataQuality>, generatedAt: String(row.generatedAt) }));
    const topContent: TopContentRecord[] = objects(topValues).map((row) => ({ key: String(row.key), periodType: "WEEK", periodStart: String(row.periodStart), periodEnd: String(row.periodEnd), platform: String(row.platform) as "youtube" | "threads", rank: number(row.rank), contentId: String(row.contentId), title: String(row.title), publishedAt: String(row.publishedAt), views: number(row.views), likes: number(row.likes), comments: nullable(row.comments), replies: nullable(row.replies), reposts: nullable(row.reposts), shares: number(row.shares), engagementRate: nullable(row.engagementRate), quality: String(row.quality) as DataQuality, generatedAt: String(row.generatedAt) }));
    return { dashboard, weekly, topContent };
  }
  async writeReport(report: ReportDocument): Promise<void> {
    const metadata = await this.sheets.spreadsheets.get({ spreadsheetId: this.spreadsheetId });
    let sheetId = metadata.data.sheets?.find((item) => item.properties?.title === SHEET)?.properties?.sheetId ?? undefined;
    if (sheetId === undefined) {
      const added = await this.sheets.spreadsheets.batchUpdate({ spreadsheetId: this.spreadsheetId, requestBody: { requests: [{ addSheet: { properties: { title: SHEET, gridProperties: { hideGridlines: true, frozenRowCount: 1 } } } }] } });
      sheetId = added.data.replies?.[0]?.addSheet?.properties?.sheetId ?? undefined;
    }
    if (sheetId === undefined) throw new Error("Report sheet ID was not returned by Google Sheets");
    await this.sheets.spreadsheets.values.clear({ spreadsheetId: this.spreadsheetId, range: `'${SHEET}'!A:H` });
    await this.sheets.spreadsheets.values.update({ spreadsheetId: this.spreadsheetId, range: `'${SHEET}'!A1`, valueInputOption: "RAW", requestBody: { values: report.lines.map((line) => [line.text]) } });
    const requests: sheets_v4.Schema$Request[] = [
      { updateSheetProperties: { properties: { sheetId, gridProperties: { hideGridlines: true, frozenRowCount: 1 } }, fields: "gridProperties(hideGridlines,frozenRowCount)" } },
      { updateDimensionProperties: { range: { sheetId, dimension: "COLUMNS", startIndex: 0, endIndex: 1 }, properties: { pixelSize: 720 }, fields: "pixelSize" } },
      { repeatCell: { range: { sheetId, startRowIndex: 0, endRowIndex: report.lines.length, startColumnIndex: 0, endColumnIndex: 1 }, cell: { userEnteredFormat: { wrapStrategy: "WRAP", verticalAlignment: "MIDDLE", textFormat: { fontSize: 11, foregroundColor: { red: 0.15, green: 0.15, blue: 0.15 } } } }, fields: "userEnteredFormat" } }
    ];
    report.lines.forEach((line, index) => {
      const height = line.kind === "spacer" ? 12 : line.kind === "title" ? 38 : line.kind === "heading" ? 30 : 24;
      requests.push({ updateDimensionProperties: { range: { sheetId, dimension: "ROWS", startIndex: index, endIndex: index + 1 }, properties: { pixelSize: height }, fields: "pixelSize" } });
      if (line.kind === "title") requests.push({ repeatCell: { range: { sheetId, startRowIndex: index, endRowIndex: index + 1, startColumnIndex: 0, endColumnIndex: 1 }, cell: { userEnteredFormat: { backgroundColor: { red: 0.2, green: 0.45, blue: 0.7 }, textFormat: { bold: true, fontSize: 16, foregroundColor: { red: 1, green: 1, blue: 1 } } } }, fields: "userEnteredFormat" } });
      if (line.kind === "heading") requests.push({ repeatCell: { range: { sheetId, startRowIndex: index, endRowIndex: index + 1, startColumnIndex: 0, endColumnIndex: 1 }, cell: { userEnteredFormat: { backgroundColor: { red: 0.92, green: 0.94, blue: 0.97 }, textFormat: { bold: true, fontSize: 12 } } }, fields: "userEnteredFormat(backgroundColor,textFormat)" } });
      if (line.kind === "note") requests.push({ repeatCell: { range: { sheetId, startRowIndex: index, endRowIndex: index + 1, startColumnIndex: 0, endColumnIndex: 1 }, cell: { userEnteredFormat: { textFormat: { italic: true, foregroundColor: { red: 0.4, green: 0.4, blue: 0.4 } } } }, fields: "userEnteredFormat.textFormat" } });
    });
    await this.sheets.spreadsheets.batchUpdate({ spreadsheetId: this.spreadsheetId, requestBody: { requests } });
  }
}
