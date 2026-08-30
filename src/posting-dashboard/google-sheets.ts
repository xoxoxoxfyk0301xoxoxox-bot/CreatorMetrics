import { google, type Auth, type sheets_v4 } from "googleapis";
import type { ContentLedgerRecord, ContentPlanRecord } from "../content-ai/types.js";
import type { PostHistoryRecord, PostQueueRecord } from "../posting/types.js";
import type { PostingDashboardDataSource, PostingDashboardOutput, PostingDashboardRaw, PostingDashboardSink } from "./types.js";

const SHEET = "PostingDashboard";
const HEADERS = ["投稿日", "投稿時刻", "投稿内容", "Status", "Content Pillar", "Core Theme", "Duplicate Status", "予約日時", "投稿済日時", "Source", "Notes"];
function objects(values: unknown[][]) { const [header = [], ...rows] = values; return rows.filter((row) => row.some((value) => value !== "")).map((row) => Object.fromEntries(header.map((name, index) => [String(name), row[index] ?? ""]))); }

export class GoogleSheetsPostingDashboardStore implements PostingDashboardDataSource, PostingDashboardSink {
  private sheets: sheets_v4.Sheets;
  constructor(auth: Auth.OAuth2Client, private id: string) { this.sheets = google.sheets({ version: "v4", auth }); }

  async readPostingData(): Promise<PostingDashboardRaw> {
    const metadata = await this.sheets.spreadsheets.get({ spreadsheetId: this.id, fields: "sheets.properties(title)" });
    const names = new Set(metadata.data.sheets?.map((sheet) => sheet.properties?.title));
    const wanted = ["PostQueue", "ContentPlan", "ContentLedger", "PostHistory"], available = wanted.filter((name) => names.has(name));
    const response = available.length ? await this.sheets.spreadsheets.values.batchGet({ spreadsheetId: this.id, ranges: available.map((name) => `'${name}'!A:Z`) }) : { data: { valueRanges: [] } };
    const byName = new Map(available.map((name, index) => [name, response.data.valueRanges?.[index]?.values ?? []]));
    const posts = objects(byName.get("PostQueue") ?? []).map((row) => ({ postId: String(row.postId), platform: String(row.platform || "threads"), content: String(row.content), contentHash: String(row.contentHash), status: String(row.status) as PostQueueRecord["status"], scheduledAt: String(row.scheduledAt), approvedAt: String(row.approvedAt), createdAt: String(row.createdAt), updatedAt: String(row.updatedAt), publishedAt: String(row.publishedAt), threadsPostId: String(row.threadsPostId), errorCode: String(row.errorCode) as PostQueueRecord["errorCode"], errorMessage: String(row.errorMessage), retryCount: Number(row.retryCount || 0), source: String(row.source || "manual") as PostQueueRecord["source"], notes: String(row.notes), requestedScheduledAt: String(row.requestedScheduledAt) }));
    const plans = objects(byName.get("ContentPlan") ?? []).map((row): ContentPlanRecord => ({ planId: String(row.planId), targetDate: String(row.targetDate), slot: String(row.slot), contentPillar: String(row.contentPillar), coreTheme: String(row.coreTheme), angle: String(row.angle), goal: String(row.goal), hookIdea: String(row.hookIdea), status: String(row.status) as ContentPlanRecord["status"], generatedPostId: String(row.generatedPostId), createdAt: String(row.createdAt), updatedAt: String(row.updatedAt), notes: String(row.notes), regenerationCount: Number(row.regenerationCount || 0) }));
    const ledger = objects(byName.get("ContentLedger") ?? []).map((row) => ({ contentId: String(row.contentId), postId: String(row.postId), platform: String(row.platform || "threads"), createdAt: String(row.createdAt), publishedAt: String(row.publishedAt), status: String(row.status), coreTheme: String(row.coreTheme), claim: String(row.claim), readerValue: String(row.readerValue), advice: String(row.advice), contentPillar: String(row.contentPillar), angle: String(row.angle), hookType: String(row.hookType), contentSummary: String(row.contentSummary), sourceType: String(row.sourceType), performanceTier: String(row.performanceTier) as ContentLedgerRecord["performanceTier"], notes: String(row.notes) }));
    const history = objects(byName.get("PostHistory") ?? []).map((row) => ({ historyId: String(row.historyId), postId: String(row.postId), platform: String(row.platform || "threads"), contentHash: String(row.contentHash), scheduledAt: String(row.scheduledAt), publishedAt: String(row.publishedAt), status: String(row.status) as PostHistoryRecord["status"], threadsPostId: String(row.threadsPostId), attempt: Number(row.attempt || 0), errorCode: String(row.errorCode) as PostHistoryRecord["errorCode"], createdAt: String(row.createdAt) }));
    return { posts, plans, ledger, history };
  }

  async writePostingDashboard(output: PostingDashboardOutput) {
    const sheetId = await this.ensure();
    await this.sheets.spreadsheets.values.clear({ spreadsheetId: this.id, range: `'${SHEET}'!A:K`, requestBody: {} });
    const summary = output.summary;
    const values: unknown[][] = [
      ["Threads Posting Dashboard", "", "", "", "", "", "", "", "", "", ""],
      ["最終更新", new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", dateStyle: "medium", timeStyle: "short" }).format(new Date(summary.generatedAt)), "今週", `${summary.weekStart} 〜 ${summary.weekEnd}`, "次回投稿", summary.nextScheduled, "", "", "", "", ""],
      ["今週の投稿予定", summary.planned, "下書き", summary.draft, "要確認", summary.review, "承認済", summary.approved, "予約済", summary.scheduled, ""],
      ["投稿済", summary.published, "エラー", summary.failed, "", "", "", "", "", "", ""],
      [],
      ["表示専用：このタブを編集しても承認・予約・投稿は実行されません。", "", "", "", "", "", "", "", "", "", ""],
      [], HEADERS,
      ...output.rows.map((row) => [row.postDate, row.postTime, row.content, row.status, row.contentPillar, row.coreTheme, row.duplicateStatus, row.scheduledAt, row.publishedAt, row.source, row.notes])
    ];
    await this.sheets.spreadsheets.values.update({ spreadsheetId: this.id, range: `'${SHEET}'!A1`, valueInputOption: "RAW", requestBody: { values } });
    await this.format(sheetId, values.length);
  }

  private async ensure(): Promise<number> {
    const metadata = await this.sheets.spreadsheets.get({ spreadsheetId: this.id });
    const existing = metadata.data.sheets?.find((sheet) => sheet.properties?.title === SHEET)?.properties?.sheetId;
    if (existing !== undefined && existing !== null) return existing;
    const response = await this.sheets.spreadsheets.batchUpdate({ spreadsheetId: this.id, requestBody: { requests: [{ addSheet: { properties: { title: SHEET, gridProperties: { frozenRowCount: 8 } } } }] } });
    return Number(response.data.replies?.[0]?.addSheet?.properties?.sheetId ?? 0);
  }

  private async format(sheetId: number, rowCount: number) {
    const metadata = await this.sheets.spreadsheets.get({ spreadsheetId: this.id, fields: "sheets(properties,conditionalFormats,basicFilter,merges)" });
    const sheet = metadata.data.sheets?.find((item) => item.properties?.sheetId === sheetId), requests: sheets_v4.Schema$Request[] = [];
    if (sheet?.basicFilter) requests.push({ clearBasicFilter: { sheetId } });
    for (let index = (sheet?.conditionalFormats?.length ?? 0) - 1; index >= 0; index--) requests.push({ deleteConditionalFormatRule: { sheetId, index } });
    const merged = sheet?.merges?.some((range) => range.startRowIndex === 0 && range.endRowIndex === 1 && range.startColumnIndex === 0 && range.endColumnIndex === 11);
    if (!merged) requests.push({ mergeCells: { range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 11 }, mergeType: "MERGE_ALL" } });
    requests.push(
      { repeatCell: { range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 11 }, cell: { userEnteredFormat: { backgroundColor: { red: .2, green: .45, blue: .7 }, textFormat: { bold: true, fontSize: 16, foregroundColor: { red: 1, green: 1, blue: 1 } }, horizontalAlignment: "CENTER" } }, fields: "userEnteredFormat" } },
      { repeatCell: { range: { sheetId, startRowIndex: 7, endRowIndex: 8, startColumnIndex: 0, endColumnIndex: 11 }, cell: { userEnteredFormat: { backgroundColor: { red: .9, green: .9, blue: .9 }, textFormat: { bold: true }, horizontalAlignment: "CENTER" } }, fields: "userEnteredFormat" } },
      { repeatCell: { range: { sheetId, startRowIndex: 8, endRowIndex: rowCount, startColumnIndex: 2, endColumnIndex: 7 }, cell: { userEnteredFormat: { wrapStrategy: "WRAP", verticalAlignment: "TOP" } }, fields: "userEnteredFormat(wrapStrategy,verticalAlignment)" } },
      { repeatCell: { range: { sheetId, startRowIndex: 8, endRowIndex: rowCount, startColumnIndex: 10, endColumnIndex: 11 }, cell: { userEnteredFormat: { wrapStrategy: "WRAP", verticalAlignment: "TOP" } }, fields: "userEnteredFormat(wrapStrategy,verticalAlignment)" } },
      { updateSheetProperties: { properties: { sheetId, gridProperties: { frozenRowCount: 8 } }, fields: "gridProperties.frozenRowCount" } },
      { setBasicFilter: { filter: { range: { sheetId, startRowIndex: 7, endRowIndex: Math.max(8, rowCount), startColumnIndex: 0, endColumnIndex: 11 } } } }
    );
    [90, 75, 420, 115, 160, 180, 120, 155, 155, 100, 240].forEach((pixelSize, index) => requests.push({ updateDimensionProperties: { range: { sheetId, dimension: "COLUMNS", startIndex: index, endIndex: index + 1 }, properties: { pixelSize }, fields: "pixelSize" } }));
    const rules: Array<[string, { red: number; green: number; blue: number }]> = [["要確認", { red: 1, green: .9, blue: .6 }], ["エラー", { red: 1, green: .75, blue: .75 }], ["予約済", { red: .8, green: .9, blue: 1 }], ["投稿済", { red: .8, green: .95, blue: .82 }]];
    for (const [text, color] of rules) requests.push({ addConditionalFormatRule: { index: 0, rule: { ranges: [{ sheetId, startRowIndex: 8, endRowIndex: rowCount, startColumnIndex: 3, endColumnIndex: 4 }], booleanRule: { condition: { type: "TEXT_EQ", values: [{ userEnteredValue: text }] }, format: { backgroundColor: color } } } } });
    await this.sheets.spreadsheets.batchUpdate({ spreadsheetId: this.id, requestBody: { requests } });
  }
}
