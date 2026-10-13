import { google, type Auth } from "googleapis";
import type { DailyMetricRecord } from "./types.js";
import type { GoogleSheetsStore } from "./store/google-sheets.js";

export const YOUTUBE_REPORTING_TIME_ZONE = "America/Los_Angeles";
export const CHANNEL_BACKFILL_METRICS = ["views", "estimatedMinutesWatched", "subscribersGained", "subscribersLost"] as const;

function dates(startDate:string,endDate:string):string[]{
  const start=new Date(`${startDate}T00:00:00Z`),end=new Date(`${endDate}T00:00:00Z`);
  if(!Number.isFinite(start.getTime())||!Number.isFinite(end.getTime())||start>end)throw new Error("INVALID_BACKFILL_RANGE");
  const values:string[]=[];for(const date=new Date(start);date<=end;date.setUTCDate(date.getUTCDate()+1))values.push(date.toISOString().slice(0,10));return values;
}

export interface ChannelPeriodSnapshot {startDate:string;endDate:string;metrics:Record<string,number|null>;source:"YouTube Analytics API aggregate query"}
export interface ChannelBackfillResult {requestedDays:number;successfulDays:number;missingDays:string[];startDate:string;endDate:string;reportingTimeZone:string;channelId:string;records:DailyMetricRecord[];totals:Record<string,number>;periods:Record<"7D"|"28D"|"90D"|"REQUESTED",ChannelPeriodSnapshot>}

export async function fetchYouTubeChannelBackfill(auth:Auth.OAuth2Client,startDate:string,endDate:string,channelId="mine",now=()=>new Date()):Promise<ChannelBackfillResult>{
  const youtube=google.youtube({version:"v3",auth}),analytics=google.youtubeAnalytics({version:"v2",auth});
  const channels=await youtube.channels.list({part:["id"],...(channelId==="mine"?{mine:true}:{id:[channelId]})}),id=channels.data.items?.[0]?.id;
  if(!id)throw new Error("YOUTUBE_CHANNEL_NOT_FOUND");
  const response=await analytics.reports.query({ids:`channel==${id}`,startDate,endDate,dimensions:"day",metrics:CHANNEL_BACKFILL_METRICS.join(","),sort:"day",maxResults:200});
  const headers=(response.data.columnHeaders??[]).map(item=>item.name??""),dayIndex=headers.indexOf("day");
  if(dayIndex<0&&(response.data.rows?.length??0)>0)throw new Error("YOUTUBE_DAY_DIMENSION_MISSING");
  const metricIndexes=Object.fromEntries(CHANNEL_BACKFILL_METRICS.map(name=>[name,headers.indexOf(name)]));
  const collectedAt=now().toISOString(),records:DailyMetricRecord[]=(response.data.rows??[]).map(row=>{
    const metrics:Record<string,number>={analyticsAvailable:1};
    for(const name of CHANNEL_BACKFILL_METRICS){const index=metricIndexes[name]??-1;if(index>=0&&Number.isFinite(Number(row[index])))metrics[name]=Number(row[index]);}
    return{date:String(row[dayIndex]),platform:"youtube",accountId:id,metrics,collectedAt};
  });
  const expected=dates(startDate,endDate),returned=new Set(records.map(row=>row.date)),totals=Object.fromEntries(CHANNEL_BACKFILL_METRICS.map(name=>[name,records.reduce((sum,row)=>sum+(row.metrics[name]??0),0)]));
  const period=async(days:number|string):Promise<ChannelPeriodSnapshot>=>{const periodStart=typeof days==="number"?dates(startDate,endDate).at(-days)??startDate:startDate,response=await analytics.reports.query({ids:`channel==${id}`,startDate:periodStart,endDate,metrics:CHANNEL_BACKFILL_METRICS.join(",")}),row=response.data.rows?.[0]??[],names=(response.data.columnHeaders??[]).map(item=>item.name??"");return{startDate:periodStart,endDate,metrics:Object.fromEntries(CHANNEL_BACKFILL_METRICS.map(name=>{const index=names.indexOf(name),value=index>=0?Number(row[index]):NaN;return[name,Number.isFinite(value)?value:null];})),source:"YouTube Analytics API aggregate query"};};
  const [d7,d28,d90,requested]=await Promise.all([period(7),period(28),period(90),period("REQUESTED")]);
  return{requestedDays:expected.length,successfulDays:records.length,missingDays:expected.filter(date=>!returned.has(date)),startDate,endDate,reportingTimeZone:YOUTUBE_REPORTING_TIME_ZONE,channelId:id,records,totals,periods:{"7D":d7,"28D":d28,"90D":d90,REQUESTED:requested}};
}

export async function backfillYouTubeChannel(auth:Auth.OAuth2Client,store:GoogleSheetsStore,startDate:string,endDate:string,channelId="mine"):Promise<ChannelBackfillResult>{
  const result=await fetchYouTubeChannelBackfill(auth,startDate,endDate,channelId);
  const existing=new Map((await store.readDailyMetrics()).filter(row=>row.platform==="youtube"&&row.accountId===result.channelId).map(row=>[row.date,row]));
  const records=result.records.map(row=>({...row,metrics:{...(existing.get(row.date)?.metrics??{}),...row.metrics}}));
  if(records.length)await store.upsertDailyMetrics(records);
  return{...result,records};
}
