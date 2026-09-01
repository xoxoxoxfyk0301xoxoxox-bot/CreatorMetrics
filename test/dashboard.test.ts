import { describe, expect, it } from "vitest";
import { generateDashboard, change } from "../src/dashboard/analytics.js";
import { comparisonPeriods, mondayOf } from "../src/dashboard/date.js";
import type { MetricValue, RawDashboardData } from "../src/dashboard/types.js";
import type { ContentMetricRecord, DailyMetricRecord, SalesMetricRecord, TransactionRecord } from "../src/types.js";

const collectedAt = "2026-08-27T00:00:00.000Z";
const empty = (): RawDashboardData => ({ daily: [], content: [], sales: [], transactions: [], payments: [], importActivity: [],collectionActivity:[] });
const daily = (date: string, platform: string, metrics: Record<string, number>): DailyMetricRecord => ({ date, platform, accountId: `${platform}-account`, metrics, collectedAt });
const content = (date: string, platform: "youtube" | "threads", id: string, values: Partial<ContentMetricRecord> = {}): ContentMetricRecord => ({ date, platform, contentId: id, contentType: platform === "youtube" ? "video" : "thread", title: id, publishedAt: "2026-08-01T00:00:00Z", views: 0, estimatedMinutesWatched: 0, likes: 0, comments: 0, shares: 0, averageViewDuration: 0, collectedAt, ...values });
const sale = (date: string, values: Partial<SalesMetricRecord> = {}): SalesMetricRecord => ({ key: date, date, yearMonth: "", periodMonth: "2026-08", platform: "rakuten_affiliate", source: "rakuten_period", shopName: "", grossSales: 0, fees: 0, netSalesBeforeTransferFee: 0, transferFees: 0, netSales: 0, commission: 0, clicks: 0, orders: 0, conversionRate: null, collectedAt, ...values });
const transaction = (status: TransactionRecord["orderStatus"], commission: number): TransactionRecord => ({ key: `order-${status}`, transactionDate: "2026-08-25", periodMonth: "2026-08", platform: "rakuten_affiliate", source: "rakuten_order", transactionId: "", paymentType: "", paymentMethod: "", contentType: "", contentName: "", grossSales: 1000, taxRate: 0, salesBeforeTax: 0, taxAmount: 0, pointsUsed: 0, commission, commissionRate: 0.1, genre: "", shopName: "shop", itemName: "item", rawStatus: "", orderStatus: status, linkType: "", deviceType: "", measurementId: "", collectedAt, sourceFileHash: "hash" });
const metric = (value: number | null, quality: MetricValue["quality"] = "OK"): MetricValue => ({ value, quality });
const collectionLog=(date:string,platform:string,status="success")=>({date,platform,status,dailyMetricsCount:1,contentMetricsCount:1,writtenDaily:1,writtenContent:1,reason:"",errorCode:"",finishedAt:`${date}T10:00:00Z`});

describe("dashboard period and quality rules", () => {
  it("compares the current partial week with the same weekdays last week", () => {
    expect(comparisonPeriods("2026-08-26")).toEqual({ current: { start: "2026-08-24", end: "2026-08-26" }, previous: { start: "2026-08-17", end: "2026-08-19" } });
  });
  it("uses complete Monday-Sunday periods on Sunday", () => {
    expect(comparisonPeriods("2026-08-30")).toEqual({ current: { start: "2026-08-24", end: "2026-08-30" }, previous: { start: "2026-08-17", end: "2026-08-23" } });
  });
  it("handles zero comparison without Infinity", () => {
    expect(change(metric(3), metric(0))).toMatchObject({ value: null, label: "NEW" });
    expect(change(metric(0), metric(0))).toMatchObject({ value: 0, label: "0%" });
    expect(change(metric(1), metric(null, "NO_DATA"))).toMatchObject({ value: null, label: "比較不能" });
  });
  it("distinguishes NO_DATA, NOT_SUPPORTED and STALE from numeric zero", () => {
    const data = empty();
    data.daily.push(daily("2026-08-24", "youtube", { views: 0, likes: 0, comments: 0, shares: 0 }));
    const output = generateDashboard(data, "2026-08-26", collectedAt);
    const youtubeViews = output.dashboard.find((row) => row.section === "YouTube" && row.metric === "今週の再生数");
    const noteSales = output.dashboard.find((row) => row.section === "note" && row.metric === "今月売上");
    const noteWeekly = output.weekly.find((row) => row.weekStart === "2026-08-24" && row.platform === "note");
    expect(youtubeViews).toMatchObject({ value: 0, display: "0", quality: "STALE" });
    expect(noteSales).toMatchObject({ value: null, display: "データなし", quality: "NO_DATA" });
    expect(noteWeekly?.quality.views).toBe("NOT_SUPPORTED");
  });
  it("marks stale manual sources from import freshness rules", () => {
    const data = empty();
    data.sales.push({ ...sale("2026-06-01"), platform: "note", source: "note_sales_summary", yearMonth: "2026-06" });
    data.importActivity.push({ platform: "note", source: "note_sales_summary", status: "success", finishedAt: "2026-06-30T00:00:00Z" }, { platform: "rakuten_affiliate", source: "rakuten_period", status: "success", finishedAt: "2026-07-01T00:00:00Z" });
    const rows = generateDashboard(data, "2026-08-28", collectedAt).dashboard;
    expect(rows.find((row) => row.section === "note" && row.metric === "最終CSV取込")?.quality).toBe("STALE");
    expect(rows.find((row) => row.section === "楽天アフィリエイト" && row.metric === "最終CSV取込")?.quality).toBe("STALE");
    expect(rows.find((row) => row.section === "note" && row.metric === "直近実績月")?.display).toBe("2026-06");
    expect(rows.find((row) => row.section === "note" && row.metric === "直近手数料控除後売上")?.value).toBe(0);
  });
  it("uses Asia/Tokyo for published-post week boundaries", () => {
    const data = empty();
    data.content.push(content("2026-08-24", "youtube", "midnight", { publishedAt: "2026-08-23T15:30:00Z" }));
    const output = generateDashboard(data, "2026-08-24", collectedAt);
    expect(mondayOf("2026-08-24")).toBe("2026-08-24");
    expect(output.dashboard.find((row) => row.section === "YouTube" && row.metric === "投稿本数")?.value).toBe(1);
  });
});

describe("snapshot and revenue aggregation", () => {
  it("does not sum Threads lifetime snapshots and requires a baseline", () => {
    const data = empty();
    data.content.push(content("2026-08-23", "threads", "t1", { views: 100, likes: 10 }), content("2026-08-25", "threads", "t1", { views: 120, likes: 12 }), content("2026-08-26", "threads", "t1", { views: 140, likes: 14 }));
    let output = generateDashboard(data, "2026-08-26", collectedAt);
    expect(output.topContent.find((row) => row.platform === "threads")?.views).toBe(40);
    data.content = data.content.filter((row) => row.date !== "2026-08-23");
    output = generateDashboard(data, "2026-08-26", collectedAt);
    expect(output.topContent.filter((row) => row.platform === "threads")).toHaveLength(0);
  });
  it("sums YouTube daily-period content values, not lifetime snapshots", () => {
    const data = empty();
    data.content.push(content("2026-08-24", "youtube", "y1", { views: 10 }), content("2026-08-25", "youtube", "y1", { views: 20 }));
    expect(generateDashboard(data, "2026-08-26", collectedAt).topContent[0]?.views).toBe(30);
  });
  it("uses Rakuten period totals once and order rows only for status analysis", () => {
    const data = empty();
    data.sales.push(sale("2026-08-25", { grossSales: 1000, commission: 100, clicks: 10, orders: 1 }));
    data.transactions.push(transaction("CONFIRMED", 100));
    const output = generateDashboard(data, "2026-08-26", collectedAt);
    expect(output.dashboard.find((row) => row.metric === "今月売上金額")?.value).toBe(1000);
    expect(output.dashboard.find((row) => row.metric === "確定報酬")?.value).toBe(100);
    expect(output.dashboard.find((row) => row.metric === "未確定報酬")?.value).toBe(0);
  });
});

describe("collection, activity and comparison status axes",()=>{
  it("treats successful YouTube zero activity as collected, not partial",()=>{const data=empty();data.daily.push(daily("2026-08-31","youtube",{channelViewCount:100,subscriberCount:1,videoCount:1}));data.content.push(content("2026-08-31","youtube","y1"));data.collectionActivity.push(collectionLog("2026-08-31","youtube"));const row=generateDashboard(data,"2026-08-31",collectedAt).weekly.find(item=>item.platform==="youtube"&&item.weekStart==="2026-08-31")!;expect(row).toMatchObject({views:0,postsPublished:0,collectionStatus:"OK",activityStatus:"ZERO_ACTIVITY",comparisonStatus:"INSUFFICIENT_BASELINE"});});
  it("treats successful YouTube actual period data as activity",()=>{const data=empty();data.content.push(content("2026-08-31","youtube","y1",{views:20}));data.collectionActivity.push(collectionLog("2026-08-31","youtube"));expect(generateDashboard(data,"2026-08-31",collectedAt).weekly.find(item=>item.platform==="youtube"&&item.weekStart==="2026-08-31")).toMatchObject({views:20,collectionStatus:"OK",activityStatus:"HAS_DATA"});});
  it("separates partial and failed collection from activity",()=>{const partial=empty();partial.daily.push(daily("2026-08-31","youtube",{views:1}),daily("2026-09-01","youtube",{views:1}));partial.collectionActivity.push(collectionLog("2026-08-31","youtube"),collectionLog("2026-09-01","youtube","failed"));expect(generateDashboard(partial,"2026-09-01",collectedAt).weekly.find(item=>item.platform==="youtube"&&item.weekStart==="2026-08-31")?.collectionStatus).toBe("PARTIAL");const failed=empty();failed.collectionActivity.push(collectionLog("2026-08-31","youtube","failed"));expect(generateDashboard(failed,"2026-08-31",collectedAt).weekly.find(item=>item.platform==="youtube"&&item.weekStart==="2026-08-31")?.collectionStatus).toBe("FAILED");});
  it("recognizes Threads 48 views and 3 posts while keeping missing baseline separate",()=>{const data=empty();data.daily.push(daily("2026-08-31","threads",{views:48,likes:1,replies:0,reposts:0}));for(let index=0;index<3;index++){data.content.push(content("2026-08-30","threads",`t${index}`,{views:10,publishedAt:"2026-08-31T01:00:00Z"}),content("2026-08-31","threads",`t${index}`,{views:16+index,publishedAt:"2026-08-31T01:00:00Z"}));}data.collectionActivity.push(collectionLog("2026-08-31","threads"));const output=generateDashboard(data,"2026-08-31",collectedAt),row=output.weekly.find(item=>item.platform==="threads"&&item.weekStart==="2026-08-31")!;expect(row).toMatchObject({views:48,postsPublished:3,collectionStatus:"OK",activityStatus:"HAS_DATA",comparisonStatus:"INSUFFICIENT_BASELINE"});expect(output.topContent.filter(item=>item.platform==="threads").length).toBeGreaterThan(0);});
  it("keeps successful Threads zero activity distinct from no data",()=>{const data=empty();data.daily.push(daily("2026-08-31","threads",{views:0,likes:0,replies:0,reposts:0}));data.content.push(content("2026-08-31","threads","old",{publishedAt:"2026-08-01T00:00:00Z"}));data.collectionActivity.push(collectionLog("2026-08-31","threads"));expect(generateDashboard(data,"2026-08-31",collectedAt).weekly.find(item=>item.platform==="threads"&&item.weekStart==="2026-08-31")).toMatchObject({collectionStatus:"OK",activityStatus:"ZERO_ACTIVITY"});});
});

describe("TopContent ranking", () => {
  it("ranks by views, engagement rate, publishedAt, then contentId", () => {
    const data = empty();
    data.content.push(
      content("2026-08-24", "youtube", "low", { views: 5, likes: 5, publishedAt: "2026-08-24T00:00:00Z" }),
      content("2026-08-24", "youtube", "engaged", { views: 10, likes: 2, publishedAt: "2026-08-23T00:00:00Z" }),
      content("2026-08-24", "youtube", "newer", { views: 10, likes: 1, publishedAt: "2026-08-25T00:00:00Z" }),
      content("2026-08-24", "youtube", "older", { views: 10, likes: 1, publishedAt: "2026-08-24T00:00:00Z" })
    );
    expect(generateDashboard(data, "2026-08-24", collectedAt).topContent.filter((row) => row.platform === "youtube").map((row) => row.contentId)).toEqual(["engaged", "newer", "older", "low"]);
  });
});
