import type { ContentLedgerRecord, ContentPlanRecord } from "../content-ai/types.js";
import type { PostHistoryRecord, PostQueueRecord } from "../posting/types.js";

export interface PostingDashboardRaw { posts:Array<Omit<PostQueueRecord,"platform">&{platform:string}>; plans:ContentPlanRecord[]; ledger:Array<Omit<ContentLedgerRecord,"platform">&{platform:string}>; history:Array<Omit<PostHistoryRecord,"platform">&{platform:string}> }
export interface PostingDashboardRow { postDate:string; postTime:string; content:string; status:string; contentPillar:string; coreTheme:string; duplicateStatus:string; scheduledAt:string; publishedAt:string; source:string; notes:string; isCurrentWeek:boolean; sortAt:string }
export interface PostingDashboardSummary { weekStart:string; weekEnd:string; planned:number; draft:number; review:number; approved:number; scheduled:number; published:number; failed:number; nextScheduled:string; generatedAt:string }
export interface PostingDashboardOutput { summary:PostingDashboardSummary; rows:PostingDashboardRow[] }
export interface PostingDashboardDataSource { readPostingData():Promise<PostingDashboardRaw> }
export interface PostingDashboardSink { writePostingDashboard(output:PostingDashboardOutput):Promise<void> }
