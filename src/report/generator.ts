import type { ActivityStatus, CollectionStatus, ComparisonStatus, DashboardOutput, DashboardRow, DataQuality, TopContentRecord, WeeklySummaryRecord } from "../dashboard/types.js";
import type { ReportDocument, ReportLine } from "./types.js";

export const REPORT_THRESHOLDS = { strongGrowth: 0.2, growth: 0.05, decline: -0.05, strongDecline: -0.2, titleLength: 80 } as const;
export interface ReportAssessment { verdict: string; sentence: string; arrow: string }

const QUALITY_TEXT: Record<Exclude<DataQuality, "OK">, ReportAssessment> = {
  STALE: { verdict: "更新待ち", sentence: "最新データの更新待ちです。", arrow: "…" },
  PARTIAL: { verdict: "一部データ", sentence: "一部データのみ取得できています。", arrow: "△" },
  NO_DATA: { verdict: "データなし", sentence: "対象期間のデータがありません。", arrow: "—" },
  NOT_SUPPORTED: { verdict: "未対応", sentence: "この指標は現在取得できません。", arrow: "—" },
  INSUFFICIENT_BASELINE: { verdict: "比較不能", sentence: "比較に必要な過去データが不足しています。", arrow: "—" }
};

export function assessChange(changeRate: number | null, changeLabel: string, quality: DataQuality): ReportAssessment {
  if (quality !== "OK") return QUALITY_TEXT[quality];
  if (changeLabel === "NEW") return { verdict: "NEW", sentence: "直近7日間から新しく動きが出ています。", arrow: "↑" };
  if (changeRate === null || changeLabel === "比較不能") return { verdict: "比較不能", sentence: "比較データが不足しています。", arrow: "—" };
  if (changeRate >= REPORT_THRESHOLDS.strongGrowth) return { verdict: "好調", sentence: "直前7日間から大きく伸びています。", arrow: "↑" };
  if (changeRate >= REPORT_THRESHOLDS.growth) return { verdict: "やや好調", sentence: "直前7日間を上回っています。", arrow: "↑" };
  if (changeRate > REPORT_THRESHOLDS.decline) return { verdict: "横ばい", sentence: "直前7日間とほぼ同水準です。", arrow: "→" };
  if (changeRate > REPORT_THRESHOLDS.strongDecline) return { verdict: "やや低下", sentence: "直前7日間を下回っています。", arrow: "↓" };
  return { verdict: "低下", sentence: "直前7日間から大きく低下しています。", arrow: "↓" };
}

export function truncateTitle(value: string, length = REPORT_THRESHOLDS.titleLength): string { return value.length <= length ? value : `${value.slice(0, length - 1)}…`; }
const jaDate = (date: string) => { const [year, month, day] = date.split("-"); return `${year}年${Number(month)}月${Number(day)}日`; };
const jaDateTime = (value: string) => new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
const row = (output: DashboardOutput, section: string, metric: string): DashboardRow | undefined => output.dashboard.find((item) => item.section === section && item.metric === metric);
const currentWeekly = (output: DashboardOutput, platform: string): WeeklySummaryRecord | undefined => output.weekly.filter((item) => item.platform === platform).sort((a, b) => b.weekStart.localeCompare(a.weekStart))[0];
const top = (output: DashboardOutput, platform: "youtube" | "threads"): TopContentRecord | undefined => output.topContent.find((item) => item.platform === platform && item.rank === 1);
const display = (item: DashboardRow | undefined, suffix = "") => item?.value === null || item?.value === undefined ? (item?.quality === "NO_DATA" ? "データなし" : "未取得") : `${item.value.toLocaleString("ja-JP")}${suffix}`;
const quality = (item: DashboardRow | undefined): DataQuality => item?.quality ?? "NO_DATA";

function platformAssessment(output: DashboardOutput, section: "YouTube" | "Threads"): ReportAssessment {
  const comparison = row(output, section, "前期間比"),weekly=currentWeekly(output,section.toLowerCase());
  return assessChange(comparison?.value ?? null, comparison?.display ?? "比較不能",weekly?.comparisonStatus==="COMPARABLE"?quality(comparison):"INSUFFICIENT_BASELINE");
}
const collectionJa:Record<CollectionStatus,string>={OK:"正常",PARTIAL:"一部取得",FAILED:"取得失敗",STALE:"更新待ち",NO_DATA:"データなし"};
const activityJa:Record<ActivityStatus,string>={HAS_DATA:"実績あり",ZERO_ACTIVITY:"対象期間実績なし",NO_DATA:"データなし"};
const comparisonJa:Record<ComparisonStatus,string>={COMPARABLE:"比較可能",INSUFFICIENT_BASELINE:"比較不能"};
function platformSituation(output:DashboardOutput,section:"YouTube"|"Threads"):string{const weekly=currentWeekly(output,section.toLowerCase()),views=row(output,section,section==="YouTube"?"直近7日間の再生数":"直近7日間の閲覧数")?.value,posts=weekly?.postsPublished;if(!weekly||weekly.collectionStatus==="NO_DATA")return`${section}は対象期間の収集記録がありません。`;if(weekly.collectionStatus==="FAILED")return`${section}は対象期間のデータ取得に失敗しています。`;if(weekly.collectionStatus==="PARTIAL")return`${section}は対象期間の収集が一部のみ成功しています。`;if(weekly.collectionStatus==="STALE")return`${section}は最新データの更新待ちです。`;if(weekly.activityStatus==="ZERO_ACTIVITY")return`${section}は正常に取得できていますが、対象期間内の新規投稿・${section==="YouTube"?"再生":"閲覧"}実績はありません。`;if(weekly.activityStatus==="HAS_DATA")return`${section}は正常に取得できており、対象期間内に${(posts??0).toLocaleString("ja-JP")}投稿、${(views??0).toLocaleString("ja-JP")}${section==="YouTube"?"再生":"閲覧"}を確認しています。`;return`${section}の収集は正常ですが、対象期間の実績データがありません。`;}
function platformLines(output: DashboardOutput, section: "YouTube" | "Threads"): ReportLine[] {
  const youtube = section === "YouTube", current = row(output, section, youtube ? "直近7日間の再生数" : "直近7日間の閲覧数"), previous = row(output, section, youtube ? "直前7日間の再生数" : "直前7日間の閲覧数"), comparison = row(output, section, "前期間比");
  const weekly = currentWeekly(output, section.toLowerCase()), candidate = top(output, section.toLowerCase() as "youtube" | "threads"), best = candidate && candidate.views > 0 ? candidate : undefined, assessment = platformAssessment(output, section);
  const lines: ReportLine[] = [{ kind: "heading", text: section }, { kind: "body", text: `直近7日間の${youtube ? "再生数" : "閲覧数"}：${display(current, "回")}` }, { kind: "body", text: `前の7日間：${display(previous, "回")}` }, { kind: "body", text: `前期間比：${comparison?.display ?? "比較不能"}` }, { kind: "spacer", text: "" }, { kind: "body", text: `直近7日間の投稿数：${weekly?.postsPublished === null || weekly?.postsPublished === undefined ? "未取得" : `${weekly.postsPublished.toLocaleString("ja-JP")}本`}` }, { kind: "spacer", text: "" }];
  if (best) lines.push({ kind: "body", text: `最も${youtube ? "再生された動画" : "閲覧された投稿"}：` }, { kind: "body", text: `「${truncateTitle(best.title)}」` }, { kind: "body", text: `${best.views.toLocaleString("ja-JP")}回` });
  else lines.push({ kind: "body", text: youtube ? "ランキングを作成できる有効な再生データがまだありません" : "ランキングを作成できる有効な閲覧データがまだありません" });
  lines.push({ kind: "spacer", text: "" }, { kind: "body", text: `取得状態：${collectionJa[weekly?.collectionStatus??"NO_DATA"]}` },{kind:"body",text:`実績状態：${activityJa[weekly?.activityStatus??"NO_DATA"]}`},{kind:"body",text:`前期間比較：${comparisonJa[weekly?.comparisonStatus??"INSUFFICIENT_BASELINE"]}`},{ kind: "spacer", text: "" });
  return lines;
}

export function generateReport(output: DashboardOutput): ReportDocument {
  const latestWeek = [...output.weekly].sort((a, b) => b.weekStart.localeCompare(a.weekStart))[0];
  const periodStart = latestWeek?.weekStart ?? "", periodEnd = latestWeek?.weekEnd ?? "";
  const generatedAt = output.dashboard[0]?.generatedAt || output.weekly[0]?.generatedAt || output.topContent[0]?.generatedAt || new Date(0).toISOString();
  const youtube = platformAssessment(output, "YouTube"), threads = platformAssessment(output, "Threads");
  const noteSales = row(output, "note", "今月売上"), noteCount = row(output, "note", "販売件数"), noteNet = row(output, "note", "今月手数料控除後売上"), noteLatestMonth = row(output, "note", "直近実績月"), noteLatestNet = row(output, "note", "直近手数料控除後売上");
  const rakutenSales = row(output, "楽天アフィリエイト", "今月売上金額"), rakutenCommission = row(output, "楽天アフィリエイト", "今月成果報酬"), confirmed = row(output, "楽天アフィリエイト", "確定報酬"), unconfirmed = row(output, "楽天アフィリエイト", "未確定報酬"), discarded = row(output, "楽天アフィリエイト", "破棄報酬");
  const revenueTotal = noteNet?.quality === "OK" && rakutenCommission?.quality === "OK" && noteNet.value !== null && rakutenCommission.value !== null ? noteNet.value + rakutenCommission.value : null;
  const noteSituation = noteSales?.quality === "OK" ? "noteは今月の売上データを取得済みです。" : noteLatestNet?.quality === "OK" && noteLatestNet.value !== null && noteLatestMonth?.display ? `noteは今月の売上データがありません。直近では${noteLatestMonth.display.replace(/^(\d{4})-(\d{2})$/, (_, year, value) => `${year}年${Number(value)}月`)}に${noteLatestNet.value.toLocaleString("ja-JP")}円の手数料控除後売上があります。` : "noteは今月の売上データがありません。";
  const rakutenSituation = quality(row(output, "楽天アフィリエイト", "最終CSV取込")) === "OK" && rakutenCommission?.quality !== "OK" ? "楽天はCSV確認済みですが、今月の成果データはありません。" : rakutenCommission?.quality === "OK" ? "楽天は今月の成果データを取得済みです。" : "楽天はCSVと今月成果データの更新待ちです。";
  const freshnessLine = (section: string, metric: string, label: string) => { const value = row(output, section, metric); return `${label}：${value?.display ?? "データなし"}${value?.quality === "STALE" ? "（更新待ち）" : ""}${metric.includes("CSV") ? " CSV取込" : " 更新"}`; };
  const lines: ReportLine[] = [
    { kind: "title", text: "Creator Metrics｜週次レポート" }, { kind: "spacer", text: "" },
    { kind: "meta", text: `対象期間：${periodStart ? `${jaDate(periodStart)}〜${jaDate(periodEnd)}` : "データなし"}` },
    { kind: "meta", text: `最終更新：${jaDateTime(generatedAt)}` }, { kind: "spacer", text: "" },
    { kind: "heading", text: "全体状況" }, { kind: "body", text: platformSituation(output,"YouTube") }, { kind: "body", text: platformSituation(output,"Threads") }, { kind: "body", text: noteSituation }, { kind: "body", text: rakutenSituation }, { kind: "spacer", text: "" },
    ...platformLines(output, "YouTube"), ...platformLines(output, "Threads"),
    { kind: "heading", text: "収益" }, { kind: "body", text: "note" }, { kind: "body", text: `今月売上：${display(noteSales, "円")}` }, { kind: "body", text: `販売件数：${display(noteCount, "件")}` }, ...(noteSales?.quality !== "OK" && noteLatestNet?.quality === "OK" && noteLatestNet.value !== null ? [{ kind: "body" as const, text: `直近実績：${noteLatestMonth?.display?.replace(/^(\d{4})-(\d{2})$/, (_, year, value) => `${year}年${Number(value)}月`) ?? "データなし"}` }, { kind: "body" as const, text: `手数料控除後売上：${noteLatestNet.value.toLocaleString("ja-JP")}円` }] : []), { kind: "spacer", text: "" },
    { kind: "body", text: "楽天" }, { kind: "body", text: `今月売上金額：${display(rakutenSales, "円")}` }, { kind: "body", text: `今月成果報酬：${display(rakutenCommission, "円")}` }, { kind: "body", text: `確定報酬：${display(confirmed, "円")}` }, { kind: "body", text: `未確定報酬：${display(unconfirmed, "円")}` }, { kind: "body", text: `破棄報酬：${display(discarded, "円")}` }, { kind: "spacer", text: "" },
    { kind: "body", text: `取得可能な収益合計：${revenueTotal === null ? "比較不能" : `${revenueTotal.toLocaleString("ja-JP")}円`}` }, { kind: "note", text: "※noteの手数料控除後売上と楽天の成果報酬だけを合計し、楽天の商品売上金額や支払額は加算していません。" }, { kind: "spacer", text: "" },
    { kind: "heading", text: "直近7日間の変化" }, { kind: "body", text: `YouTube：${youtube.arrow} ${youtube.verdict}` }, { kind: "body", text: `Threads：${threads.arrow} ${threads.verdict}` }, { kind: "body", text: `note：${quality(row(output, "note", "最終CSV取込")) === "OK" && noteSales?.quality === "OK" ? "CSV確認済み・今月売上データあり" : quality(row(output, "note", "最終CSV取込")) === "OK" ? "CSV確認済み・今月売上データなし" : "データ更新待ち"}` }, { kind: "body", text: `楽天：${quality(row(output, "楽天アフィリエイト", "最終CSV取込")) === "OK" && rakutenCommission?.quality === "OK" ? "CSV確認済み・今月成果データあり" : quality(row(output, "楽天アフィリエイト", "最終CSV取込")) === "OK" ? "CSV確認済み・今月成果データなし" : "データ更新待ち"}` }, { kind: "spacer", text: "" },
    { kind: "heading", text: "データ状態" }, { kind: "body", text: freshnessLine("YouTube", "最終データ更新", "YouTube") }, { kind: "body", text: freshnessLine("Threads", "最終データ更新", "Threads") }, { kind: "body", text: freshnessLine("note", "最終CSV取込", "note") }, { kind: "body", text: freshnessLine("楽天アフィリエイト", "最終CSV取込", "楽天") }
  ];
  return { generatedAt, periodStart, periodEnd, lines };
}
