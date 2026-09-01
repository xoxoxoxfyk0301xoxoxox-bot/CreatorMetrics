import type { ContentMetricRecord, DailyMetricRecord, SalesMetricRecord, TransactionRecord } from "../types.js";
import { addDays, comparisonPeriods, dateInTokyo, datesInRange, mondayOf, monthOf, normalizeYearMonth, sundayOf } from "./date.js";
import type { ActivityStatus, CollectionStatus, ComparisonStatus, DashboardOutput, DashboardRow, DataQuality, MetricValue, PeriodRange, RawDashboardData, TopContentRecord, WeeklySummaryRecord } from "./types.js";
import { calculateFreshness } from "./freshness.js";

export const METRIC_SEMANTICS = {
  youtube: { dailyAccount: "period", content: "period", channelViewCount: "snapshot", subscriberCount: "snapshot", videoCount: "snapshot" },
  threads: { dailyAccount: "period", followers: "snapshot", content: "snapshot" },
  note: { salesSummary: "period", salesHistory: "increment" },
  rakuten_affiliate: { periodReport: "period", orderReport: "snapshot", commissionPayment: "period" }
} as const;

const supported = (value: number, quality: DataQuality = "OK"): MetricValue => ({ value, quality });
const missing = (quality: DataQuality): MetricValue => ({ value: null, quality });
function worst(values: DataQuality[]): DataQuality {
  const rank: Record<DataQuality, number> = { OK: 0, NOT_SUPPORTED: 1, NO_DATA: 2, STALE: 3, PARTIAL: 4, INSUFFICIENT_BASELINE: 5 };
  return values.reduce((result, value) => rank[value] > rank[result] ? value : result, "OK" as DataQuality);
}
function coverageQuality(range: PeriodRange, covered: Set<string>): DataQuality {
  const expected = datesInRange(range);
  if (!covered.size) return "NO_DATA";
  if (covered.size === expected.length) return "OK";
  const latest = [...covered].sort().at(-1)!;
  return latest < range.end ? "STALE" : "PARTIAL";
}
function aggregateDaily(rows: DailyMetricRecord[], platform: string, range: PeriodRange, metric: string): MetricValue {
  const relevant = rows.filter((row) => row.platform === platform && row.date >= range.start && row.date <= range.end);
  const values = relevant.filter((row) => Object.hasOwn(row.metrics, metric));
  if (!values.length) return missing(relevant.length ? "PARTIAL" : "NO_DATA");
  const covered = new Set(values.map((row) => row.date));
  return supported(values.reduce((sum, row) => sum + row.metrics[metric]!, 0), coverageQuality(range, covered));
}
function aggregateContentPeriod(rows:ContentMetricRecord[],platform:string,range:PeriodRange,metric:"views"|"likes"|"comments"|"shares"):MetricValue{const relevant=rows.filter(row=>row.platform===platform&&row.date>=range.start&&row.date<=range.end);if(!relevant.length)return missing("NO_DATA");return supported(relevant.reduce((sum,row)=>sum+row[metric],0),coverageQuality(range,new Set(relevant.map(row=>row.date))));}
function collectionStatus(data:RawDashboardData,platform:string,range:PeriodRange):CollectionStatus{const all=data.collectionActivity.filter(row=>row.platform===platform).sort((a,b)=>a.finishedAt.localeCompare(b.finishedAt)),latestByDate=new Map<string,(typeof all)[number]>();for(const row of all)latestByDate.set(row.date,row);const expected=datesInRange(range),relevant=expected.map(date=>latestByDate.get(date)).filter((row):row is (typeof all)[number]=>Boolean(row));if(!relevant.length)return all.length?"STALE":"NO_DATA";const success=relevant.filter(row=>row.status==="success").length,failed=relevant.length-success;if(failed&&success)return"PARTIAL";if(failed&&!success)return"FAILED";if(relevant.length<expected.length)return relevant.map(row=>row.date).sort().at(-1)!<range.end?"STALE":"PARTIAL";return"OK";}
function activityStatus(primary:MetricValue,posts:MetricValue):ActivityStatus{if((primary.value??0)>0||(posts.value??0)>0)return"HAS_DATA";if(primary.value===0||posts.value===0)return"ZERO_ACTIVITY";return"NO_DATA";}
const comparisonStatus=(previous:MetricValue):ComparisonStatus=>previous.value===null?"INSUFFICIENT_BASELINE":"COMPARABLE";
function postsPublished(content: ContentMetricRecord[], platform: string, range: PeriodRange): MetricValue {
  const relevant = content.filter((row) => row.platform === platform);
  if (!relevant.length) return missing("NO_DATA");
  const ids = new Set(relevant.filter((row) => { const date = dateInTokyo(row.publishedAt); return date >= range.start && date <= range.end; }).map((row) => row.contentId));
  return supported(ids.size);
}
function aggregateRakuten(sales: SalesMetricRecord[], range: PeriodRange, field: "grossSales" | "commission" | "clicks" | "orders"): MetricValue {
  const relevant = sales.filter((row) => row.platform === "rakuten_affiliate" && row.source === "rakuten_period" && row.date >= range.start && row.date <= range.end);
  if (!relevant.length) return missing("NO_DATA");
  const values = relevant.map((row) => row[field]).filter((value): value is number => value !== null);
  if (!values.length) return missing("NO_DATA");
  const covered = new Set(relevant.map((row) => row.date));
  return supported(values.reduce((sum, value) => sum + value, 0), coverageQuality(range, covered));
}
function change(current: MetricValue, previous: MetricValue): { value: number | null; label: string; quality: DataQuality } {
  if (current.value === null || previous.value === null) return { value: null, label: "比較不能", quality: current.quality === "INSUFFICIENT_BASELINE" || previous.quality === "INSUFFICIENT_BASELINE" ? "INSUFFICIENT_BASELINE" : worst([current.quality, previous.quality]) };
  if (previous.value === 0) return current.value === 0 ? { value: 0, label: "0%", quality: worst([current.quality, previous.quality]) } : { value: null, label: "NEW", quality: worst([current.quality, previous.quality]) };
  const value = (current.value - previous.value) / previous.value;
  return { value, label: `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)}%`, quality: worst([current.quality, previous.quality]) };
}

function snapshotDelta(content: ContentMetricRecord[], platform: "threads", range: PeriodRange, metric: keyof ContentMetricRecord): { values: Map<string, { row: ContentMetricRecord; value: number }>; quality: DataQuality } {
  const rows = content.filter((row) => row.platform === platform);
  const ids = new Set(rows.filter((row) => row.date >= range.start && row.date <= range.end).map((row) => row.contentId));
  const values = new Map<string, { row: ContentMetricRecord; value: number }>();
  let insufficient = false;
  for (const id of ids) {
    const snapshots = rows.filter((row) => row.contentId === id).sort((a, b) => a.date.localeCompare(b.date));
    const end = snapshots.filter((row) => row.date <= range.end).at(-1);
    const baseline = snapshots.filter((row) => row.date < range.start).at(-1);
    if (!end || !baseline) { insufficient = true; continue; }
    const endValue = end[metric], baselineValue = baseline[metric];
    if (typeof endValue !== "number" || typeof baselineValue !== "number") { insufficient = true; continue; }
    values.set(id, { row: end, value: endValue - baselineValue });
  }
  if (!ids.size) return { values, quality: "NO_DATA" };
  return { values, quality: insufficient ? (values.size ? "PARTIAL" : "INSUFFICIENT_BASELINE") : "OK" };
}

function weeklyForPlatform(data: RawDashboardData, platform: string, range: PeriodRange, generatedAt: string): WeeklySummaryRecord {
  const notSupported = missing("NOT_SUPPORTED");
  const metric = (name: string): MetricValue => {
    if (platform === "youtube") {
      if (["views", "likes", "comments", "shares"].includes(name)){const daily=aggregateDaily(data.daily,platform,range,name);return daily.value===null?aggregateContentPeriod(data.content,platform,range,name as "views"|"likes"|"comments"|"shares"):daily;}
      return notSupported;
    }
    if (platform === "threads") {
      if (["views", "likes", "replies", "reposts"].includes(name)) return aggregateDaily(data.daily, platform, range, name);
      if (name === "shares") { const delta = snapshotDelta(data.content, "threads", range, "shares"); return delta.values.size ? supported([...delta.values.values()].reduce((sum, item) => sum + item.value, 0), delta.quality) : missing(delta.quality); }
      return notSupported;
    }
    if (platform === "rakuten_affiliate" && ["clicks", "orders", "grossSales", "commission"].includes(name)) return aggregateRakuten(data.sales, range, name as "clicks" | "orders" | "grossSales" | "commission");
    return notSupported;
  };
  const values = { views: metric("views"), likes: metric("likes"), comments: metric("comments"), replies: metric("replies"), reposts: metric("reposts"), shares: metric("shares"), clicks: metric("clicks"), orders: metric("orders"), grossSales: metric("grossSales"), commission: metric("commission"), postsPublished: platform === "youtube" || platform === "threads" ? postsPublished(data.content, platform, range) : notSupported };
  const quality = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value.quality]));
  return { key: `${range.start}|${platform}`, weekStart: range.start, weekEnd: range.end, platform, views: values.views.value, likes: values.likes.value, comments: values.comments.value, replies: values.replies.value, reposts: values.reposts.value, shares: values.shares.value, clicks: values.clicks.value, orders: values.orders.value, grossSales: values.grossSales.value, commission: values.commission.value, postsPublished: values.postsPublished.value, previousPeriodValue: null, changeRate: null, changeLabel: "比較不能", overallQuality: worst(Object.values(quality)), quality,collectionStatus:platform==="youtube"||platform==="threads"?collectionStatus(data,platform,range):"NO_DATA",activityStatus:activityStatus(values.views,values.postsPublished),comparisonStatus:"INSUFFICIENT_BASELINE",generatedAt };
}

function buildWeekly(data: RawDashboardData, asOf: string, generatedAt: string): WeeklySummaryRecord[] {
  const dated = [...data.daily.map((row) => row.date), ...data.sales.filter((row) => row.source === "rakuten_period").map((row) => row.date)].filter(Boolean).sort();
  const first = dated[0] ? mondayOf(dated[0]) : mondayOf(asOf);
  const weeks: PeriodRange[] = [];
  for (let start = first; start <= asOf; start = addDays(start, 7)) weeks.push({ start, end: sundayOf(start) < asOf ? sundayOf(start) : asOf });
  const rows = weeks.flatMap((range) => ["youtube", "threads", "note", "rakuten_affiliate"].map((platform) => weeklyForPlatform(data, platform, range, generatedAt)));
  for (const row of rows) {
    const previousEnd = row.weekEnd === sundayOf(row.weekStart) ? addDays(row.weekStart, -1) : addDays(row.weekEnd, -7);
    const previousStart = addDays(row.weekStart, -7);
    const previous = weeklyForPlatform(data, row.platform, { start: previousStart, end: previousEnd }, generatedAt);
    const primary = row.platform === "youtube" || row.platform === "threads" ? { value: row.views, quality: row.quality.views! } : row.platform === "rakuten_affiliate" ? { value: row.grossSales, quality: row.quality.grossSales! } : missing("NOT_SUPPORTED");
    const previousPrimary = previous.platform === "youtube" || previous.platform === "threads" ? { value: previous.views, quality: previous.quality.views! } : previous.platform === "rakuten_affiliate" ? { value: previous.grossSales, quality: previous.quality.grossSales! } : missing("NOT_SUPPORTED");
    const comparison = change(primary, previousPrimary);
    row.previousPeriodValue = previousPrimary.value; row.changeRate = comparison.value; row.changeLabel = comparison.label;row.comparisonStatus=comparisonStatus(previousPrimary);
  }
  return rows;
}

function aggregateYoutubeTop(content: ContentMetricRecord[], range: PeriodRange, generatedAt: string): TopContentRecord[] {
  const rows = content.filter((row) => row.platform === "youtube" && row.date >= range.start && row.date <= range.end);
  const dates = new Set(rows.map((row) => row.date)), quality = coverageQuality(range, dates);
  const groups = new Map<string, ContentMetricRecord[]>();
  for (const row of rows) groups.set(row.contentId, [...(groups.get(row.contentId) ?? []), row]);
  return [...groups.values()].map((items) => {
    const latest = [...items].sort((a, b) => a.date.localeCompare(b.date)).at(-1)!;
    const sum = (field: "views" | "likes" | "comments" | "shares") => items.reduce((total, row) => total + row[field], 0);
    const views = sum("views"), likes = sum("likes"), comments = sum("comments"), shares = sum("shares"), engagementRate = views ? (likes + comments + shares) / views : 0;
    return { key: "", periodType: "WEEK" as const, periodStart: range.start, periodEnd: range.end, platform: "youtube" as const, rank: 0, contentId: latest.contentId, title: latest.title, publishedAt: latest.publishedAt, views, likes, comments, replies: null, reposts: null, shares, engagementRate, quality, generatedAt };
  });
}
function aggregateThreadsTop(content: ContentMetricRecord[], range: PeriodRange, generatedAt: string): TopContentRecord[] {
  const fields = ["views", "likes", "replies", "reposts", "shares"] as const;
  const deltas = Object.fromEntries(fields.map((field) => [field, snapshotDelta(content, "threads", range, field)])) as Record<(typeof fields)[number], ReturnType<typeof snapshotDelta>>;
  const ids = new Set([...deltas.views.values.keys()]);
  return [...ids].map((id) => {
    const row = deltas.views.values.get(id)!.row;
    const value = (field: (typeof fields)[number]) => deltas[field].values.get(id)?.value ?? 0;
    const views = value("views"), likes = value("likes"), replies = value("replies"), reposts = value("reposts"), shares = value("shares"), engagementRate = views ? (likes + replies + reposts + shares) / views : 0;
    return { key: "", periodType: "WEEK", periodStart: range.start, periodEnd: range.end, platform: "threads", rank: 0, contentId: id, title: row.title, publishedAt: row.publishedAt, views, likes, comments: null, replies, reposts, shares, engagementRate, quality: worst(fields.map((field) => deltas[field].quality)), generatedAt };
  });
}
function rankTop(rows: TopContentRecord[]): TopContentRecord[] {
  return rows.sort((a, b) => b.views - a.views || (b.engagementRate ?? -1) - (a.engagementRate ?? -1) || b.publishedAt.localeCompare(a.publishedAt) || a.contentId.localeCompare(b.contentId)).slice(0, 5).map((row, index) => ({ ...row, rank: index + 1, key: `${row.periodType}|${row.periodStart}|${row.platform}|${index + 1}` }));
}

const qualityJa: Record<DataQuality, string> = { OK: "", NO_DATA: "データなし", NOT_SUPPORTED: "未対応", INSUFFICIENT_BASELINE: "比較データ不足", STALE: "更新待ち", PARTIAL: "一部データ" };
function dashboardRow(section: string, metric: string, value: MetricValue, period: string, generatedAt: string, format: "number" | "currency" = "number"): DashboardRow {
  const display = value.value === null ? qualityJa[value.quality] : format === "currency" ? `${value.value.toLocaleString("ja-JP")}円` : value.value.toLocaleString("ja-JP");
  return { section, metric, value: value.value, display, quality: value.quality, period, generatedAt };
}
function monthMetric(sales: SalesMetricRecord[], platform: string, source: string, month: string, field: "grossSales" | "commission" | "netSalesBeforeTransferFee"): MetricValue {
  const rows = sales.filter((row) => row.platform === platform && row.source === source && (normalizeYearMonth(row.yearMonth) ?? row.periodMonth) === month);
  return rows.length ? supported(rows.reduce((sum, row) => sum + row[field], 0)) : missing("NO_DATA");
}
function latestNoteSales(sales: SalesMetricRecord[], asOfMonth: string): { month: string; net: number } | null {
  const rows = sales.filter((row) => row.platform === "note" && row.source === "note_sales_summary").map((row) => ({ row, month: normalizeYearMonth(row.yearMonth) ?? row.periodMonth ?? "" })).filter((item) => item.month && item.month <= asOfMonth).sort((a, b) => b.month.localeCompare(a.month));
  const latestMonth = rows[0]?.month;
  if (!latestMonth) return null;
  return { month: latestMonth, net: rows.filter((item) => item.month === latestMonth).reduce((sum, item) => sum + item.row.netSalesBeforeTransferFee, 0) };
}
function transactionCommission(transactions: TransactionRecord[], month: string, status: string): MetricValue {
  const all = transactions.filter((row) => row.platform === "rakuten_affiliate" && row.source === "rakuten_order" && monthOf(row.transactionDate) === month);
  if (!all.length) return missing("NO_DATA");
  return supported(all.filter((row) => row.orderStatus === status).reduce((sum, row) => sum + row.commission, 0));
}
function buildDashboard(data: RawDashboardData, asOf: string, generatedAt: string): DashboardRow[] {
  const { current, previous } = comparisonPeriods(asOf), month = monthOf(asOf), previousMonthDate = addDays(`${month}-01`, -1), previousMonth = monthOf(previousMonthDate);
  const freshness = calculateFreshness(data, asOf);
  const rows: DashboardRow[] = [{ section: "概要", metric: "最終更新", value: null, display: asOf, quality: "OK", period: asOf, generatedAt }];
  for (const platform of ["youtube", "threads"] as const) {
    const label = platform === "youtube" ? "YouTube" : "Threads",dailyViews=aggregateDaily(data.daily,platform,current,"views"),views=platform==="youtube"&&dailyViews.value===null?aggregateContentPeriod(data.content,platform,current,"views"):dailyViews,previousDaily=aggregateDaily(data.daily,platform,previous,"views"),previousViews=platform==="youtube"&&previousDaily.value===null?aggregateContentPeriod(data.content,platform,previous,"views"):previousDaily, comparison = change(views, previousViews),posts=postsPublished(data.content,platform,current),collection=collectionStatus(data,platform,current),activity=activityStatus(views,posts),comparisonState=comparisonStatus(previousViews);
    rows.push({ section: label, metric: "最終データ更新", value: null, display: freshness[platform].display, quality: freshness[platform].quality, period: freshness[platform].value ?? "", generatedAt });
    rows.push(dashboardRow(label, platform === "youtube" ? "今週の再生数" : "今週の閲覧数", views, `${current.start}〜${current.end}`, generatedAt));
    rows.push(dashboardRow(label, platform === "youtube" ? "先週の再生数" : "先週の閲覧数", previousViews, `${previous.start}〜${previous.end}`, generatedAt));
    rows.push({ section: label, metric: "前週比", value: comparison.value, display: comparison.label, quality: comparison.quality, period: `${current.start}〜${current.end} / ${previous.start}〜${previous.end}`, generatedAt });
    rows.push(dashboardRow(label, "今週のいいね", aggregateDaily(data.daily, platform, current, "likes"), `${current.start}〜${current.end}`, generatedAt));
    rows.push(dashboardRow(label, platform === "youtube" ? "今週のコメント" : "今週の返信", aggregateDaily(data.daily, platform, current, platform === "youtube" ? "comments" : "replies"), `${current.start}〜${current.end}`, generatedAt));
    if (platform === "threads") rows.push(dashboardRow(label, "今週のリポスト", aggregateDaily(data.daily, platform, current, "reposts"), `${current.start}〜${current.end}`, generatedAt));
    rows.push(dashboardRow(label, "投稿本数", posts, `${current.start}〜${current.end}`, generatedAt));
    const collectionJa:Record<CollectionStatus,string>={OK:"正常",PARTIAL:"一部取得",FAILED:"取得失敗",STALE:"更新待ち",NO_DATA:"データなし"},activityJa:Record<ActivityStatus,string>={HAS_DATA:"実績あり",ZERO_ACTIVITY:"対象期間実績なし",NO_DATA:"データなし"},comparisonJa:Record<ComparisonStatus,string>={COMPARABLE:"比較可能",INSUFFICIENT_BASELINE:"比較不能"};
    rows.push({section:label,metric:"取得状態",value:null,display:collectionJa[collection],quality:collection==="OK"?"OK":collection==="PARTIAL"?"PARTIAL":collection==="STALE"?"STALE":"NO_DATA",period:`${current.start}〜${current.end}`,generatedAt},{section:label,metric:"実績状態",value:null,display:activityJa[activity],quality:activity==="NO_DATA"?"NO_DATA":"OK",period:`${current.start}〜${current.end}`,generatedAt},{section:label,metric:"前週比較状態",value:null,display:comparisonJa[comparisonState],quality:comparisonState==="COMPARABLE"?"OK":"INSUFFICIENT_BASELINE",period:`${previous.start}〜${previous.end}`,generatedAt});
  }
  const noteCurrent = monthMetric(data.sales, "note", "note_sales_summary", month, "grossSales"), notePrevious = monthMetric(data.sales, "note", "note_sales_summary", previousMonth, "grossSales"), noteChange = change(noteCurrent, notePrevious);
  const noteLatest = latestNoteSales(data.sales, month);
  const noteTransactions = data.transactions.filter((row) => row.platform === "note" && row.source === "note_sales_history" && monthOf(row.transactionDate) === month);
  rows.push({ section: "note", metric: "最終CSV取込", value: null, display: freshness.note.display, quality: freshness.note.quality, period: freshness.note.value ?? "", generatedAt }, dashboardRow("note", "今月売上", noteCurrent, month, generatedAt, "currency"), dashboardRow("note", "今月手数料控除後売上", monthMetric(data.sales, "note", "note_sales_summary", month, "netSalesBeforeTransferFee"), month, generatedAt, "currency"), { section: "note", metric: "直近実績月", value: null, display: noteLatest?.month ?? "データなし", quality: noteLatest ? "OK" : "NO_DATA", period: noteLatest?.month ?? "", generatedAt }, dashboardRow("note", "直近手数料控除後売上", noteLatest ? supported(noteLatest.net) : missing("NO_DATA"), noteLatest?.month ?? "", generatedAt, "currency"), dashboardRow("note", "前月売上", notePrevious, previousMonth, generatedAt, "currency"), { section: "note", metric: "前月比", value: noteChange.value, display: noteChange.label, quality: noteChange.quality, period: `${month} / ${previousMonth}`, generatedAt }, dashboardRow("note", "販売件数", noteTransactions.length ? supported(noteTransactions.filter((row) => row.grossSales > 0).length) : missing("NO_DATA"), month, generatedAt));
  const range = { start: `${month}-01`, end: asOf };
  rows.push({ section: "楽天アフィリエイト", metric: "最終CSV取込", value: null, display: freshness.rakuten_affiliate.display, quality: freshness.rakuten_affiliate.quality, period: freshness.rakuten_affiliate.value ?? "", generatedAt }, dashboardRow("楽天アフィリエイト", "今月売上金額", aggregateRakuten(data.sales, range, "grossSales"), month, generatedAt, "currency"), dashboardRow("楽天アフィリエイト", "今月成果報酬", aggregateRakuten(data.sales, range, "commission"), month, generatedAt, "currency"), dashboardRow("楽天アフィリエイト", "確定報酬", transactionCommission(data.transactions, month, "CONFIRMED"), month, generatedAt, "currency"), dashboardRow("楽天アフィリエイト", "未確定報酬", transactionCommission(data.transactions, month, "UNCONFIRMED"), month, generatedAt, "currency"), dashboardRow("楽天アフィリエイト", "破棄報酬", transactionCommission(data.transactions, month, "DISCARDED"), month, generatedAt, "currency"), dashboardRow("楽天アフィリエイト", "クリック数", aggregateRakuten(data.sales, range, "clicks"), month, generatedAt), dashboardRow("楽天アフィリエイト", "売上件数", aggregateRakuten(data.sales, range, "orders"), month, generatedAt));
  return rows;
}

export function generateDashboard(data: RawDashboardData, asOf: string, generatedAt = new Date().toISOString()): DashboardOutput {
  const current = comparisonPeriods(asOf).current;
  return { dashboard: buildDashboard(data, asOf, generatedAt), weekly: buildWeekly(data, asOf, generatedAt), topContent: [...rankTop(aggregateYoutubeTop(data.content, current, generatedAt)), ...rankTop(aggregateThreadsTop(data.content, current, generatedAt))] };
}
export { change };
