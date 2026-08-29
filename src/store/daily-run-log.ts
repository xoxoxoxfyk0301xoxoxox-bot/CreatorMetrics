import { google, type Auth, type sheets_v4 } from "googleapis";
import type { DailyRunLogRecord, DailyRunLogStore } from "../daily.js";

const SHEET = "DailyRunLog";
const HEADER = ["runId", "startedAt", "finishedAt", "referenceDate", "youtubeStatus", "threadsStatus", "dashboardStatus", "overallStatus", "durationMs", "errorSummary", "reportStatus"];

export class GoogleSheetsDailyRunLogStore implements DailyRunLogStore {
  private readonly sheets: sheets_v4.Sheets;
  constructor(auth: Auth.OAuth2Client, private readonly spreadsheetId: string) { this.sheets = google.sheets({ version: "v4", auth }); }
  async upsertDailyRunLog(record: DailyRunLogRecord): Promise<void> {
    const metadata = await this.sheets.spreadsheets.get({ spreadsheetId: this.spreadsheetId });
    const sheet = metadata.data.sheets?.find((item) => item.properties?.title === SHEET);
    if (!sheet) await this.sheets.spreadsheets.batchUpdate({ spreadsheetId: this.spreadsheetId, requestBody: { requests: [{ addSheet: { properties: { title: SHEET, gridProperties: { frozenRowCount: 1 } } } }] } });
    const header = await this.sheets.spreadsheets.values.get({ spreadsheetId: this.spreadsheetId, range: `'${SHEET}'!1:1` });
    if (JSON.stringify(header.data.values?.[0] ?? []) !== JSON.stringify(HEADER)) await this.sheets.spreadsheets.values.update({ spreadsheetId: this.spreadsheetId, range: `'${SHEET}'!A1`, valueInputOption: "RAW", requestBody: { values: [HEADER] } });
    const ids = await this.sheets.spreadsheets.values.get({ spreadsheetId: this.spreadsheetId, range: `'${SHEET}'!A2:A` });
    const row = (ids.data.values ?? []).findIndex((value) => value[0] === record.runId) + 2;
    const values = [[record.runId, record.startedAt, record.finishedAt, record.referenceDate, record.youtubeStatus, record.threadsStatus, record.dashboardStatus, record.overallStatus, record.durationMs, record.errorSummary, record.reportStatus]];
    if (row >= 2) await this.sheets.spreadsheets.values.update({ spreadsheetId: this.spreadsheetId, range: `'${SHEET}'!A${row}:K${row}`, valueInputOption: "RAW", requestBody: { values } });
    else await this.sheets.spreadsheets.values.append({ spreadsheetId: this.spreadsheetId, range: `'${SHEET}'!A:K`, valueInputOption: "RAW", insertDataOption: "INSERT_ROWS", requestBody: { values } });
  }
}
