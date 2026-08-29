import { describe, expect, it } from "vitest";
import { printDailySummary, runDaily, safeError, type DailyRunLogRecord, type DailyRunLogStore } from "../src/daily.js";
import type { CollectionResult } from "../src/collector.js";
import type { DashboardOutput } from "../src/dashboard/types.js";
import type { ReportDocument } from "../src/report/types.js";

class MemoryLog implements DailyRunLogStore {
  rows = new Map<string, DailyRunLogRecord>();
  async upsertDailyRunLog(record: DailyRunLogRecord) { this.rows.set(record.runId, record); }
}
const collection = (platform: string, status: "success" | "failed" = "success", error?: string): CollectionResult => ({ platform, status, dailyMetrics: status === "success" ? 1 : 0, contentMetrics: 0, writtenDaily: status === "success" ? 1 : 0, writtenContent: 0, reason: status === "failed" ? "collection failed" : "", ...(error ? { error } : {}) });
const dashboard: DashboardOutput = { dashboard: [], weekly: [], topContent: [] };
const report: ReportDocument = { generatedAt: "2026-08-29T00:00:00Z", periodStart: "2026-08-24", periodEnd: "2026-08-28", lines: [] };
const clocks = () => { const values = [new Date("2026-08-29T00:00:00Z"), new Date("2026-08-29T00:00:12.400Z")]; return () => values.shift() ?? values.at(-1)!; };
function setup(youtube: "success" | "failed", threads: "success" | "failed", dashboardFails = false, log = new MemoryLog()) {
  return { log, dependencies: { collectYouTube: async () => collection("youtube", youtube), collectThreads: async () => collection("threads", threads), generateDashboard: async () => { if (dashboardFails) throw new Error("dashboard unavailable"); return dashboard; }, generateReport: async () => report, logStore: log } };
}

describe("Daily Orchestrator", () => {
  it("completes all steps successfully", async () => {
    const { dependencies } = setup("success", "success");
    const result = await runDaily("2026-08-28", dependencies, { now: clocks() });
    expect(result.log).toMatchObject({ youtubeStatus: "SUCCESS", threadsStatus: "SUCCESS", dashboardStatus: "SUCCESS", reportStatus: "SUCCESS", overallStatus: "SUCCESS", durationMs: 12400 });
  });
  it.each([["failed", "success", "FAILED", "SUCCESS"], ["success", "failed", "SUCCESS", "FAILED"]] as const)("isolates a %s/%s collection result", async (youtube, threads, youtubeStatus, threadsStatus) => {
    const { dependencies } = setup(youtube, threads);
    expect((await runDaily("2026-08-28", dependencies)).log).toMatchObject({ youtubeStatus, threadsStatus, dashboardStatus: "SUCCESS_WITH_PARTIAL_DATA", overallStatus: "PARTIAL" });
  });
  it("still generates a partial dashboard when both collections fail", async () => {
    const { dependencies } = setup("failed", "failed");
    const result = await runDaily("2026-08-28", dependencies);
    expect(result.dashboard).toBe(dashboard);
    expect(result.log).toMatchObject({ dashboardStatus: "SUCCESS_WITH_PARTIAL_DATA", overallStatus: "PARTIAL" });
  });
  it("records dashboard generation failure", async () => {
    const { dependencies } = setup("success", "success", true);
    expect((await runDaily("2026-08-28", dependencies)).log).toMatchObject({ dashboardStatus: "FAILED", overallStatus: "FAILED" });
  });
  it("records Report failure without losing a successful Dashboard", async () => {
    const runSetup = setup("success", "success");
    runSetup.dependencies.generateReport = async () => { throw new Error("report unavailable"); };
    expect((await runDaily("2026-08-28", runSetup.dependencies)).log).toMatchObject({ dashboardStatus: "SUCCESS", reportStatus: "FAILED", overallStatus: "PARTIAL" });
  });
  it("runs Dashboard before Report", async () => {
    const order: string[] = [], log = new MemoryLog();
    await runDaily("2026-08-28", { collectYouTube: async () => { order.push("youtube"); return collection("youtube"); }, collectThreads: async () => { order.push("threads"); return collection("threads"); }, generateDashboard: async () => { order.push("dashboard"); return dashboard; }, generateReport: async () => { order.push("report"); return report; }, logStore: log });
    expect(order).toEqual(["youtube", "threads", "dashboard", "report"]);
  });
  it("upserts the same runId without duplicating DailyRunLog", async () => {
    const shared = new MemoryLog(), runSetup = setup("success", "success", false, shared);
    await runDaily("2026-08-28", runSetup.dependencies, { runId: "same-run" });
    await runDaily("2026-08-28", runSetup.dependencies, { runId: "same-run" });
    expect(shared.rows.size).toBe(1);
  });
  it("does not expose secrets in errors or the Japanese summary", async () => {
    const secret = "super-secret-token", log = new MemoryLog();
    const result = await runDaily("2026-08-28", { collectYouTube: async () => collection("youtube"), collectThreads: async () => collection("threads", "failed", `access_token=${secret}`), generateDashboard: async () => dashboard, generateReport: async () => report, logStore: log }, { now: clocks() });
    const lines: string[] = []; printDailySummary(result, (line) => lines.push(line));
    expect(safeError(`client_secret=${secret}`, { GOOGLE_CLIENT_SECRET: secret })).not.toContain(secret);
    expect(lines.join("\n")).not.toContain(secret);
    expect(lines.join("\n")).toContain("Threads: 失敗");
  });
});
