import { describe,expect,it } from "vitest";
import { buildPostingDashboard,duplicateJapanese,sourceJapanese,statusJapanese,tokyoWeek } from "../src/posting-dashboard/analytics.js";
import { runPostingDashboard } from "../src/posting-dashboard/index.js";
import type { PostingDashboardOutput,PostingDashboardRaw } from "../src/posting-dashboard/types.js";
import type { PostQueueRecord } from "../src/posting/types.js";
import type { ContentLedgerRecord,ContentPlanRecord } from "../src/content-ai/types.js";

const post=(changes:Partial<PostQueueRecord>={}):PostQueueRecord=>({postId:"p1",platform:"threads",content:"投稿内容を省略せず表示します",contentHash:"hidden",status:"DRAFT",scheduledAt:"",approvedAt:"",createdAt:"2026-08-31T00:00:00Z",updatedAt:"2026-08-31T00:00:00Z",publishedAt:"",threadsPostId:"",errorCode:"",errorMessage:"",retryCount:0,source:"manual",notes:"",requestedScheduledAt:"",...changes});
const plan=(changes:Partial<ContentPlanRecord>={}):ContentPlanRecord=>({planId:"plan1",targetDate:"2026-09-01",slot:"08:00",contentPillar:"時間管理",coreTheme:"朝の15分",angle:"実践",goal:"小さく始める",hookIdea:"朝",status:"GENERATED",generatedPostId:"p1",createdAt:"",updatedAt:"",notes:"",regenerationCount:0,...changes});
const ledger=(changes:Partial<ContentLedgerRecord>={}):ContentLedgerRecord=>({contentId:"p1",postId:"p1",platform:"threads",createdAt:"",publishedAt:"",status:"DRAFT",coreTheme:"15分で始める",claim:"",readerValue:"",advice:"",contentPillar:"継続と時間管理",angle:"",hookType:"",contentSummary:"",sourceType:"AI_CONTENT_PHASE3",performanceTier:"INSUFFICIENT_DATA",notes:"",...changes});
const raw=(changes:Partial<PostingDashboardRaw>={}):PostingDashboardRaw=>({posts:[post()],plans:[],ledger:[],history:[],...changes});
describe("PostingDashboard",()=>{
 it("translates statuses, sources, and duplicate states",()=>{expect(statusJapanese("SCHEDULED")).toBe("予約済");expect(statusJapanese("SKIPPED_DUPLICATE")).toBe("重複除外");expect(sourceJapanese("AI_CONTENT_PHASE3")).toBe("AI案");expect(sourceJapanese("import")).toBe("一括取込");expect(duplicateJapanese("POSSIBLE_DUPLICATE")).toBe("類似あり");});
 it("uses Asia/Tokyo Monday-Sunday boundaries",()=>{expect(tokyoWeek("2026-09-02")).toEqual({start:"2026-08-31",end:"2026-09-06"});});
 it("summarizes the current week and finds the next scheduled post",()=>{const output=buildPostingDashboard(raw({posts:[post({status:"DRAFT"}),post({postId:"p2",status:"REVIEW"}),post({postId:"p3",status:"SCHEDULED",scheduledAt:"2026-09-01T23:00:00Z"})]}),"2026-08-31",new Date("2026-08-31T00:00:00Z"));expect(output.summary).toMatchObject({planned:3,draft:1,review:1,scheduled:1,nextScheduled:"2026-09-02 08:00"});});
 it("joins ContentPlan and ContentLedger without guessing",()=>{const output=buildPostingDashboard(raw({posts:[post({source:"AI_CONTENT_PHASE3",notes:"planId=plan1; semantic=POSSIBLE_DUPLICATE"})],plans:[plan()],ledger:[ledger()]}),"2026-08-31");expect(output.rows[0]).toMatchObject({postDate:"2026-09-01",postTime:"08:00",contentPillar:"継続と時間管理",coreTheme:"15分で始める",duplicateStatus:"類似あり",source:"AI案"});});
 it("marks missing metadata explicitly",()=>{const row=buildPostingDashboard(raw(),"2026-08-31").rows[0];expect(row).toMatchObject({contentPillar:"未設定",coreTheme:"未設定",duplicateStatus:"未判定"});});
 it("includes ungenerated ContentPlan rows",()=>{const output=buildPostingDashboard(raw({posts:[],plans:[plan({status:"PLANNED",generatedPostId:""})]}),"2026-08-31");expect(output.rows[0]).toMatchObject({status:"企画済",content:"",contentPillar:"時間管理"});});
 it("generation reads sources and writes only the dashboard",async()=>{const input=raw(),snapshot=JSON.stringify(input);let written:PostingDashboardOutput|undefined,publishCalls=0;const output=await runPostingDashboard({async readPostingData(){return input;}},{async writePostingDashboard(value){written=value;}},"2026-08-31",new Date("2026-08-31T00:00:00Z"));expect(written).toEqual(output);expect(JSON.stringify(input)).toBe(snapshot);expect(publishCalls).toBe(0);});
});
