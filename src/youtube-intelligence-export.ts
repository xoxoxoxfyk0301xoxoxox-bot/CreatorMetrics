import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { google, type Auth } from "googleapis";

export const YOUTUBE_INTELLIGENCE_SCHEMA_VERSION = "3.0.0";
const METRICS = ["views", "engagedViews", "watchTimeMinutes", "averageViewDuration", "averagePercentageViewed", "subscribersGained", "subscribersLost", "likes", "comments"] as const;
type MetricName = typeof METRICS[number];
type MetricValues = Record<MetricName, number | null>;

export interface ExportInput { contentRows: Record<string, unknown>[]; dailyRows: Record<string, unknown>[]; generatedAt?: string; timeZone?: string; backfill?: Record<string,unknown> }

const num = (value: unknown): number | null => value === "" || value === null || value === undefined || !Number.isFinite(Number(value)) ? null : Number(value);
const text = (value: unknown): string => value == null ? "" : String(value);
const blankMetrics = (): MetricValues => Object.fromEntries(METRICS.map((name) => [name, null])) as MetricValues;
const analyticsAvailable = (row: Record<string, unknown>) => row.analyticsAvailable === true || String(row.analyticsAvailable).toLowerCase() === "true";
const addDays = (date: string, days: number): string => { const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
export function dateInZone(value: string, timeZone = "Asia/Tokyo"): string {
  const date = new Date(value); if (!Number.isFinite(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}
function periodMetrics(row: Record<string, unknown>): MetricValues {
  return { views:num(row.views),engagedViews:num(row.engagedViews),watchTimeMinutes:num(row.estimatedMinutesWatched),averageViewDuration:num(row.averageViewDuration),averagePercentageViewed:num(row.averageViewPercentage),subscribersGained:num(row.subscribersGained),subscribersLost:num(row.subscribersLost),likes:num(row.likes),comments:num(row.comments) };
}
function lifetimeMetrics(row: Record<string, unknown>): MetricValues {
  return { views:num(row.lifetimeViews),engagedViews:num(row.lifetimeEngagedViews),watchTimeMinutes:num(row.lifetimeEstimatedMinutesWatched),averageViewDuration:num(row.lifetimeAverageViewDuration),averagePercentageViewed:num(row.lifetimeAverageViewPercentage),subscribersGained:num(row.lifetimeSubscribersGained),subscribersLost:num(row.lifetimeSubscribersLost),likes:num(row.lifetimeLikes),comments:num(row.lifetimeComments) };
}
function cumulative(rows: Map<string, Record<string, unknown>>, start: string, dayCount: number) {
  const expected = Array.from({length:dayCount},(_,index)=>addDays(start,index));
  const present = expected.filter((date)=>{const row=rows.get(date);return Boolean(row)&&analyticsAvailable(row!);});
  if (present.length !== expected.length) return { available:false, quality:"INSUFFICIENT_COVERAGE", coveredDays:present, expectedDays:expected, metrics:blankMetrics() };
  const source = expected.map((date)=>periodMetrics(rows.get(date)!));
  const values = blankMetrics();
  for (const metric of METRICS) {
    const samples = source.map((item)=>item[metric]);
    if (samples.some((value)=>value===null)) continue;
    values[metric] = metric === "averageViewDuration" || metric === "averagePercentageViewed"
      ? (samples as number[]).reduce((sum,value)=>sum+value,0)/samples.length
      : (samples as number[]).reduce((sum,value)=>sum+value,0);
  }
  return { available:true, quality:"OK", coveredDays:present, expectedDays:expected, metrics:values };
}
export function buildYouTubeIntelligenceExport(input: ExportInput) {
  const generatedAt=input.generatedAt??new Date().toISOString(),timeZone=input.timeZone??"Asia/Tokyo";
  const youtube=input.contentRows.filter((row)=>text(row.platform).toLowerCase()==="youtube");
  const groups=new Map<string,Record<string,unknown>[]>();for(const row of youtube){const id=text(row.contentId);if(id)groups.set(id,[...(groups.get(id)??[]),row]);}
  const videos=[...groups.entries()].map(([videoId,rows])=>{rows.sort((a,b)=>text(a.date).localeCompare(text(b.date)));const latest=rows.at(-1)!;const publishedDate=dateInZone(text(latest.publishedAt),"America/Los_Angeles");const byDate=new Map(rows.map((row)=>[text(row.date),row]));
    const history=rows.map((row)=>({date:text(row.date),collectedAt:text(row.collectedAt),available:analyticsAvailable(row),semantics:text(row.metricSemantics)||"period",metrics:periodMetrics(row)}));
    return {videoId,title:text(latest.title)||null,publishedAt:text(latest.publishedAt)||null,contentType:text(latest.contentType)||null,durationSeconds:num(latest.videoDurationSeconds),launch:{day1:cumulative(byDate,publishedDate,1),day2:cumulative(byDate,publishedDate,2),day7:cumulative(byDate,publishedDate,7),definition:"YouTube Analytics Pacific Time calendar-day cumulative; Day1 is publication calendar day, not rolling 24 hours; missing days are not interpolated."},lifetime:{available:METRICS.some((metric)=>lifetimeMetrics(latest)[metric]!==null),quality:"SNAPSHOT",asOf:text(latest.lifetimeCollectedAt)||text(latest.collectedAt),metrics:lifetimeMetrics(latest)},history};
  }).sort((a,b)=>text(b.publishedAt).localeCompare(text(a.publishedAt))||a.videoId.localeCompare(b.videoId));
  const channelRows=input.dailyRows.filter((row)=>text(row.platform).toLowerCase()==="youtube").sort((a,b)=>text(a.date).localeCompare(text(b.date))).map((row)=>{let metrics:Record<string,unknown>|null=null;try{metrics=typeof row.metrics==="string"?JSON.parse(row.metrics):row.metrics as Record<string,unknown>;}catch{}return{row,metrics};});
  const latestDaily=channelRows.at(-1),latestMetrics=latestDaily?.metrics??null,lifetimeDaily=[...channelRows].reverse().find(({metrics})=>num(metrics?.lifetimeViews)!==null),lifetimeMetricsSource=lifetimeDaily?.metrics??null;
  const channelHistory=channelRows.map(({row,metrics})=>({date:text(row.date),collectedAt:text(row.collectedAt),available:Number(metrics?.analyticsAvailable)===1,metrics:{views:num(metrics?.views),watchTimeMinutes:num(metrics?.estimatedMinutesWatched),subscribersGained:num(metrics?.subscribersGained),subscribersLost:num(metrics?.subscribersLost),likes:num(metrics?.likes),comments:num(metrics?.comments)}}));
  const channelLifetime=lifetimeMetricsSource?{available:true,quality:"CHANNEL_ANALYTICS_SNAPSHOT",asOf:text(lifetimeDaily?.row.collectedAt),metrics:{views:num(lifetimeMetricsSource.lifetimeViews),engagedViews:num(lifetimeMetricsSource.lifetimeEngagedViews),watchTimeMinutes:num(lifetimeMetricsSource.lifetimeEstimatedMinutesWatched),averageViewDuration:null,averagePercentageViewed:null,subscribersGained:num(lifetimeMetricsSource.lifetimeSubscribersGained),subscribersLost:num(lifetimeMetricsSource.lifetimeSubscribersLost),likes:num(lifetimeMetricsSource.lifetimeLikes),comments:num(lifetimeMetricsSource.lifetimeComments)}}:null;
  const backfill=input.backfill&&input.backfill.schemaVersion==="1.0.0"?input.backfill:null;
  return {schemaVersion:YOUTUBE_INTELLIGENCE_SCHEMA_VERSION,generatedAt,timeZone,source:{name:"creator-metrics-collector",officialApis:["YouTube Analytics API","YouTube Data API v3"],reportingTimeZone:"America/Los_Angeles",semantics:{daily:"channel-level period",periods:"direct channel aggregate query",lifetime:"channel-level Analytics snapshot",videoLifetime:"per-video Analytics snapshot",current:"Data API current snapshot",launch:"calendar-day cumulative"}},availability:{videoId:{available:true},title:{available:true},publishedAt:{available:true},videoDuration:{available:true},views:{available:true,distinctFrom:"engagedViews"},watchTime:{available:true,officialName:"estimatedMinutesWatched",unit:"minutes"},averageViewDuration:{available:true},averagePercentageViewed:{available:true,officialName:"averageViewPercentage"},subscribersGained:{available:true},subscribersLost:{available:true},currentSubscribers:{available:true,source:"YouTube Data API statistics.subscriberCount"},likes:{available:true},comments:{available:true},engagedViews:{available:true,definition:"Shorts engaged views; never substituted for views"},impressions:{available:false,reason:"Not available from the implemented YouTube Analytics targeted query."},ctr:{available:false,reason:"Thumbnail impressions CTR requires a separate Reporting API pipeline."},stayedToWatch:{available:false,reason:"No supported public targeted Analytics metric is implemented; not inferred from engaged views."},swipedAway:{available:false,reason:"No supported public targeted Analytics metric is implemented."}},channel:latestDaily?{date:text(latestDaily.row.date),accountId:text(latestDaily.row.accountId),current:{viewCount:num(latestMetrics?.channelViewCount),subscriberCount:num(latestMetrics?.subscriberCount),videoCount:num(latestMetrics?.videoCount)},lifetime:channelLifetime,history:channelHistory,periods:backfill?.periods??null,coverage:backfill?{startDate:backfill.startDate,endDate:backfill.endDate,requestedDays:backfill.requestedDays,successfulDays:backfill.successfulDays,missingDays:backfill.missingDays,reportingTimeZone:backfill.reportingTimeZone,lastCollectedAt:backfill.generatedAt}:null}:null,videos};
}
function rows(values: unknown[][]):Record<string,unknown>[] {const [header=[],...body]=values;return body.filter((row)=>row.some((cell)=>cell!=="")).map((row)=>Object.fromEntries(header.map((name,index)=>[String(name),row[index]??""])));}
export async function readYouTubeExportInput(auth:Auth.OAuth2Client,spreadsheetId:string):Promise<ExportInput>{const api=google.sheets({version:"v4",auth});const result=await api.spreadsheets.values.batchGet({spreadsheetId,ranges:["'ContentMetrics'!A:AH","'DailyMetrics'!A:H"]});return{contentRows:rows(result.data.valueRanges?.[0]?.values??[]),dailyRows:rows(result.data.valueRanges?.[1]?.values??[]) };}
export async function writeYouTubeIntelligenceExport(output:unknown,file="exports/youtube-channel-intelligence.json"):Promise<void>{await mkdir(dirname(file),{recursive:true});const temporary=`${file}.tmp`;await writeFile(temporary,`${JSON.stringify(output,null,2)}\n`,"utf8");await rename(temporary,file);}
