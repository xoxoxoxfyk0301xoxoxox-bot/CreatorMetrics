import { describe, expect, it, vi } from "vitest";
import { assessChange, generateReport, truncateTitle } from "../src/report/generator.js";
import { runReport } from "../src/report/index.js";
import type { DashboardOutput, DashboardRow, DataQuality, TopContentRecord, WeeklySummaryRecord } from "../src/dashboard/types.js";

const generatedAt = "2026-08-29T00:30:00.000Z";
const dashboardRow = (section: string, metric: string, value: number | null, display: string, quality: DataQuality = "OK"): DashboardRow => ({ section, metric, value, display, quality, period: "2026-08-24〜2026-08-28", generatedAt });
const weekly = (platform: string, postsPublished: number | null): WeeklySummaryRecord => ({ key: `2026-08-24|${platform}`, weekStart: "2026-08-24", weekEnd: "2026-08-28", platform, views: 1, likes: 1, comments: null, replies: null, reposts: null, shares: null, clicks: null, orders: null, grossSales: null, commission: null, postsPublished, previousPeriodValue: 1, changeRate: 0.1, changeLabel: "+10.0%", overallQuality: "OK", quality: {},collectionStatus:"OK",activityStatus:"HAS_DATA",comparisonStatus:"COMPARABLE",generatedAt });
const best = (platform: "youtube" | "threads", title = "Top title"): TopContentRecord => ({ key: `${platform}-1`, periodType: "WEEK", periodStart: "2026-08-24", periodEnd: "2026-08-28", platform, rank: 1, contentId: "private-id", title, publishedAt: "2026-08-20T00:00:00Z", views: 100, likes: 10, comments: platform === "youtube" ? 1 : null, replies: platform === "threads" ? 1 : null, reposts: platform === "threads" ? 1 : null, shares: 1, engagementRate: 0.12, quality: "OK", generatedAt });
function output(options: { youtubeRate?: number | null; youtubeLabel?: string; youtubeQuality?: DataQuality; top?: boolean; noteNet?: number | null; noteQuality?: DataQuality; rakutenCommission?: number | null; rakutenQuality?: DataQuality } = {}): DashboardOutput {
  const rate = options.youtubeRate ?? 0.1, label = options.youtubeLabel ?? "+10.0%", quality = options.youtubeQuality ?? "OK";
  const noteSalesValue = options.noteQuality === "NO_DATA" ? null : 1000;
  const dashboard = [
    dashboardRow("概要", "最終更新", null, "2026-08-28"), dashboardRow("YouTube", "最終データ更新", null, "2026-08-28"), dashboardRow("YouTube", "直近7日間の再生数", 120, "120"), dashboardRow("YouTube", "直前7日間の再生数", 100, "100"), dashboardRow("YouTube", "前期間比", rate, label, quality),
    dashboardRow("Threads", "最終データ更新", null, "2026-08-28"), dashboardRow("Threads", "直近7日間の閲覧数", 50, "50"), dashboardRow("Threads", "直前7日間の閲覧数", 50, "50"), dashboardRow("Threads", "前期間比", 0, "0%"),
    dashboardRow("note", "最終CSV取込", null, "2026-08-28"), dashboardRow("note", "今月売上", noteSalesValue, noteSalesValue === null ? "データなし" : "1,000円", options.noteQuality ?? "OK"), dashboardRow("note", "今月手数料控除後売上", options.noteNet === undefined ? 800 : options.noteNet, options.noteNet === null ? "データなし" : "800円", options.noteQuality ?? "OK"), dashboardRow("note", "直近実績月", null, "2026-06"), dashboardRow("note", "直近手数料控除後売上", 252, "252円"), dashboardRow("note", "販売件数", 2, "2"),
    dashboardRow("楽天アフィリエイト", "最終CSV取込", null, "2026-08-28"), dashboardRow("楽天アフィリエイト", "今月売上金額", 5000, "5,000円"), dashboardRow("楽天アフィリエイト", "今月成果報酬", options.rakutenCommission === undefined ? 200 : options.rakutenCommission, options.rakutenCommission === null ? "データなし" : "200円", options.rakutenQuality ?? "OK"), dashboardRow("楽天アフィリエイト", "確定報酬", 200, "200円"), dashboardRow("楽天アフィリエイト", "未確定報酬", 0, "0円"), dashboardRow("楽天アフィリエイト", "破棄報酬", 0, "0円")
  ];
  return { dashboard, weekly: [weekly("youtube", 0), weekly("threads", null)], topContent: options.top === false ? [] : [best("youtube"), best("threads")] };
}
const text = (value: DashboardOutput) => generateReport(value).lines.map((line) => line.text).join("\n");

describe("rule-based report assessments", () => {
  it.each([
    [0.2, "+20%", "好調"], [0.05, "+5%", "やや好調"], [0.049, "+4.9%", "横ばい"], [-0.05, "-5%", "やや低下"], [-0.2, "-20%", "低下"]
  ] as const)("classifies %s as %s", (rate, label, verdict) => expect(assessChange(rate, label, "OK").verdict).toBe(verdict));
  it("handles NEW and comparison unavailable", () => {
    expect(assessChange(null, "NEW", "OK").verdict).toBe("NEW");
    expect(assessChange(null, "比較不能", "OK").verdict).toBe("比較不能");
  });
  it.each(["STALE", "PARTIAL", "NO_DATA", "NOT_SUPPORTED", "INSUFFICIENT_BASELINE"] as const)("prioritizes %s over numeric change", (quality) => {
    expect(assessChange(1, "+100%", quality).verdict).not.toBe("好調");
  });
});

describe("report content", () => {
  it("renders TopContent, keeps known zero, and distinguishes null", () => {
    const report = text(output());
    expect(report).toContain("「Top title」");
    expect(report).toContain("直近7日間の投稿数：0本");
    expect(report).toContain("直近7日間の投稿数：未取得");
  });
  it("explains when TopContent is unavailable", () => expect(text(output({ top: false }))).toContain("ランキングを作成できる有効な再生データがまだありません"));
  it("does not rank zero-view content", () => {
    const value = output(); value.topContent[0] = { ...value.topContent[0]!, views: 0 };
    expect(text(value)).toContain("ランキングを作成できる有効な再生データがまだありません");
    expect(text(value)).not.toContain("最も再生された動画：");
  });
  it("does not total Rakuten gross sales or duplicate confirmed commission", () => {
    const report = text(output());
    expect(report).toContain("取得可能な収益合計：1,000円");
    expect(report).not.toContain("取得可能な収益合計：6,000円");
  });
  it("does not create a total when note CSV revenue is missing", () => expect(text(output({ noteNet: null, noteQuality: "NO_DATA" }))).toContain("取得可能な収益合計：比較不能"));
  it("labels manual-source freshness as CSV import", () => {
    const report = text(output());
    expect(report).toContain("note：2026-08-28 CSV取込");
    expect(report).toContain("楽天：2026-08-28 CSV取込");
  });
  it("separates successful CSV import from current Rakuten result availability", () => {
    const report = text(output({ rakutenCommission: null, rakutenQuality: "NO_DATA" }));
    expect(report).toContain("楽天：CSV確認済み・今月成果データなし");
    expect(report).toContain("楽天はCSV確認済みですが、今月の成果データはありません。");
  });
  it("shows the latest note result when the current month is unavailable", () => {
    const report = text(output({ noteNet: null, noteQuality: "NO_DATA" }));
    expect(report).toContain("直近実績：2026年6月");
    expect(report).toContain("手数料控除後売上：252円");
    expect(report).toContain("直近では2026年6月に252円の手数料控除後売上があります。");
  });
  it("truncates only the Report title copy", () => {
    const original = "あ".repeat(100), truncated = truncateTitle(original);
    expect(truncated).toHaveLength(80); expect(truncated.endsWith("…")).toBe(true); expect(original).toHaveLength(100);
  });
  it("keeps collection, activity and comparison states consistent with visible metrics",()=>{const value=output({top:false}),youtube=value.weekly.find(item=>item.platform==="youtube")!,threads=value.weekly.find(item=>item.platform==="threads")!;Object.assign(youtube,{views:0,postsPublished:0,collectionStatus:"OK",activityStatus:"ZERO_ACTIVITY",comparisonStatus:"INSUFFICIENT_BASELINE"});Object.assign(threads,{views:48,postsPublished:3,collectionStatus:"OK",activityStatus:"HAS_DATA",comparisonStatus:"INSUFFICIENT_BASELINE"});const yt=value.dashboard.find(item=>item.section==="YouTube"&&item.metric==="直近7日間の再生数")!,th=value.dashboard.find(item=>item.section==="Threads"&&item.metric==="直近7日間の閲覧数")!;Object.assign(yt,{value:0,display:"0",quality:"OK"});Object.assign(th,{value:48,display:"48",quality:"OK"});const report=text(value);expect(report).toContain("YouTubeは正常に取得できていますが、対象期間内の新規投稿・再生実績はありません。");expect(report).toContain("Threadsは正常に取得できており、対象期間内に3投稿、48閲覧を確認しています。");expect(report).toContain("取得状態：正常");expect(report).toContain("実績状態：実績あり");expect(report).toContain("前期間比較：比較不能");expect(report).not.toContain("Threadsは対象期間のデータがありません。");expect(report).not.toContain("YouTubeは一部データのみ取得できています。");});
  it("reports the same rolling seven-day total as Dashboard",()=>{const value=output();const youtube=value.weekly.find(item=>item.platform==="youtube")!;Object.assign(youtube,{weekStart:"2026-08-27",weekEnd:"2026-09-02",views:158});const current=value.dashboard.find(item=>item.section==="YouTube"&&item.metric==="直近7日間の再生数")!;Object.assign(current,{value:158,display:"158",period:"2026-08-27〜2026-09-02"});const report=generateReport(value);expect(report.periodStart).toBe("2026-08-27");expect(report.periodEnd).toBe("2026-09-02");expect(report.lines.map(line=>line.text)).toContain("直近7日間の再生数：158回");});
  it("regenerates Report alone through source and sink", async () => {
    const input = output(), writeReport = vi.fn();
    const result = await runReport({ readDashboardOutput: async () => input }, { writeReport });
    expect(writeReport).toHaveBeenCalledOnce(); expect(result.lines[0]?.text).toBe("Creator Metrics｜週次レポート");
  });
});
