import { randomUUID } from "node:crypto";
import type { CollectionResult } from "./collector.js";
import type { DashboardOutput } from "./dashboard/types.js";
import type { ReportDocument } from "./report/types.js";

export type DailyStepStatus = "SUCCESS" | "FAILED";
export type DashboardRunStatus = "SUCCESS" | "SUCCESS_WITH_PARTIAL_DATA" | "FAILED";
export interface DailyRunLogRecord {
  runId: string; startedAt: string; finishedAt: string; referenceDate: string;
  youtubeStatus: DailyStepStatus; threadsStatus: DailyStepStatus; dashboardStatus: DashboardRunStatus;
  overallStatus: "SUCCESS" | "PARTIAL" | "FAILED"; durationMs: number; errorSummary: string;
  reportStatus: DailyStepStatus;
}
export interface DailyRunLogStore { upsertDailyRunLog(record: DailyRunLogRecord): Promise<void> }
export interface DailyDependencies {
  collectYouTube(): Promise<CollectionResult>;
  collectThreads(): Promise<CollectionResult>;
  generateDashboard(): Promise<DashboardOutput>;
  generateReport(output: DashboardOutput): Promise<ReportDocument>;
  logStore: DailyRunLogStore;
}
export interface DailyRunResult { log: DailyRunLogRecord; errors: Partial<Record<"youtube" | "threads" | "dashboard" | "report" | "log", string>>; dashboard?: DashboardOutput; report?: ReportDocument }

const SECRET_NAMES = ["GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN", "THREADS_APP_SECRET", "THREADS_ACCESS_TOKEN", "PINTEREST_ACCESS_TOKEN"];
export function safeError(error: unknown, env: NodeJS.ProcessEnv = process.env): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const name of SECRET_NAMES) { const secret = env[name]; if (secret) message = message.replaceAll(secret, "[REDACTED]"); }
  message = message.replace(/(access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|app[_ -]?secret)\s*[=:]\s*[^\s;,]+/gi, "$1=[REDACTED]");
  message = message.replace(/channel==[^\s;,]+/gi, "channel==[REDACTED]").replace(/\bUC[A-Za-z0-9_-]{20,}\b/g, "[REDACTED_ID]").replace(/\b\d{8,}\b/g, "[REDACTED_ID]");
  return message.slice(0, 500);
}

async function collectionStep(run: () => Promise<CollectionResult>): Promise<{ status: DailyStepStatus; error?: string }> {
  try {
    const result = await run();
    return result.status === "success" ? { status: "SUCCESS" } : { status: "FAILED", error: safeError(result.error || result.reason) };
  } catch (error) { return { status: "FAILED", error: safeError(error) }; }
}

export async function runDaily(referenceDate: string, dependencies: DailyDependencies, options: { runId?: string; now?: () => Date } = {}): Promise<DailyRunResult> {
  const now = options.now ?? (() => new Date()), runId = options.runId ?? randomUUID(), started = now(), errors: DailyRunResult["errors"] = {};
  const youtube = await collectionStep(dependencies.collectYouTube); if (youtube.error) errors.youtube = youtube.error;
  const threads = await collectionStep(dependencies.collectThreads); if (threads.error) errors.threads = threads.error;
  let dashboardStatus: DashboardRunStatus = youtube.status === "SUCCESS" && threads.status === "SUCCESS" ? "SUCCESS" : "SUCCESS_WITH_PARTIAL_DATA";
  let dashboard: DashboardOutput | undefined;
  try { dashboard = await dependencies.generateDashboard(); }
  catch (error) { dashboardStatus = "FAILED"; errors.dashboard = safeError(error); }
  let reportStatus: DailyStepStatus = "FAILED", report: ReportDocument | undefined;
  if (dashboard) {
    try { report = await dependencies.generateReport(dashboard); reportStatus = "SUCCESS"; }
    catch (error) { errors.report = safeError(error); }
  } else errors.report = "Dashboard generation did not complete.";
  const finished = now();
  const overallStatus = dashboardStatus === "FAILED" ? "FAILED" : youtube.status === "SUCCESS" && threads.status === "SUCCESS" && reportStatus === "SUCCESS" ? "SUCCESS" : "PARTIAL";
  const log: DailyRunLogRecord = { runId, startedAt: started.toISOString(), finishedAt: finished.toISOString(), referenceDate, youtubeStatus: youtube.status, threadsStatus: threads.status, dashboardStatus, overallStatus, durationMs: Math.max(0, finished.getTime() - started.getTime()), errorSummary: Object.entries(errors).map(([step, message]) => `${step}: ${message}`).join("; "), reportStatus };
  try { await dependencies.logStore.upsertDailyRunLog(log); }
  catch (error) { errors.log = safeError(error); }
  return { log, errors, ...(dashboard ? { dashboard } : {}), ...(report ? { report } : {}) };
}

export function printDailySummary(result: DailyRunResult, write: (line: string) => void = console.log): void {
  const ja = (status: DailyStepStatus) => status === "SUCCESS" ? "成功" : "失敗";
  write("Creator Metrics Daily Update"); write("");
  write(`YouTube: ${ja(result.log.youtubeStatus)}`); if (result.errors.youtube) write(`理由: ${result.errors.youtube}`);
  write(`Threads: ${ja(result.log.threadsStatus)}`); if (result.errors.threads) write(`理由: ${result.errors.threads}`);
  write(`Dashboard: ${result.log.dashboardStatus === "SUCCESS" ? "更新完了" : result.log.dashboardStatus === "SUCCESS_WITH_PARTIAL_DATA" ? "一部データで更新完了" : "更新失敗"}`); if (result.errors.dashboard) write(`理由: ${result.errors.dashboard}`);
  write(`Report: ${result.log.reportStatus === "SUCCESS" ? "更新完了" : "更新失敗"}`); if (result.errors.report) write(`理由: ${result.errors.report}`);
  write(""); write(`基準日: ${result.log.referenceDate}`); write(`所要時間: ${(result.log.durationMs / 1000).toFixed(1)}秒`);
}
