import { randomUUID } from "node:crypto";
import { acquireDailyLock } from "../daily-lock.js";
import { safeError } from "../daily.js";
import { ThreadsApiError, type ThreadsPublishingApi } from "../threads-client.js";
import { contentHash, duplicateCheck, normalizeContent } from "./duplicate.js";
import { assertTransition } from "./state.js";
import { inferPostingSlot, jitterCandidates, jstDateTime, jstIso, type PostingSlot } from "./time-windows.js";
import type { PostErrorCode, PostHistoryRecord, PostQueueRecord, PostStatus, PostStore, PublisherRunLogRecord, PublisherRunStore } from "./types.js";

export const POSTING_LIMITS = { maxCharacters: 500, maxRetries: 3, minimumIntervalMinutes: 60, maxOverdueMinutes: 360 } as const;
export interface ImportCandidate { content: string; scheduledAt: string; notes: string }
export interface ImportErrorDetail { row: number; preview: string; scheduledAt: string; error: string }
export interface ImportSummary { read: number; draft: number; review: number; duplicate: number; errors: number; errorDetails: ImportErrorDetail[]; posts: PostQueueRecord[] }
export interface ImportDuplicateCleanupTarget { postId: string; keptPostId: string; status: "DRAFT" | "REVIEW"; createdAt: string; contentHash: string }
export interface ImportDuplicateCleanupSummary { apply: boolean; scanned: number; duplicateGroups: number; targets: ImportDuplicateCleanupTarget[] }
export interface ScheduleImportedOptions { jitter?: boolean; dryRun?: boolean }
export interface DueSummary { dueCount: number; publishedCount: number; failedCount: number; expiredCount: number; skippedCount: number; dryRun: boolean; targets: { postId: string; action: "PUBLISH" | "EXPIRE" }[] }
export interface DryRunResult { postId: string; status: PostStatus; content: string; scheduledAt: string; duplicate: { exact: boolean; near: boolean }; publishable: boolean; tokenValid: boolean; reason: string }
function validateContent(content: string): string { const value = normalizeContent(content); if (!value) throw new Error("Post content must not be empty"); if ([...value].length > POSTING_LIMITS.maxCharacters) throw new Error(`Post content exceeds ${POSTING_LIMITS.maxCharacters} characters`); return value; }
function importPreview(content: string): string { const value=content.replace(/\s+/g," ").trim(); return [...value].slice(0,40).join("") + ([...value].length>40?"…":""); }
function safeImportError(error: unknown): string {
  const message=safeError(error);
  return message
    .replace(/(bearer\s+)[^\s,;]+/gi,"$1[REDACTED]")
    .replace(/((?:access[_-]?token|refresh[_-]?token|api[_-]?key|client[_-]?secret|app[_-]?secret|oauth[_-]?code)\s*[=:]\s*)[^\s,;]+/gi,"$1[REDACTED]");
}
export function formatImportErrorDetails(details: ImportErrorDetail[]): string {
  if (!details.length) return "";
  return `\n\nエラー詳細:\n\n${details.map(detail=>`- row=${detail.row} scheduledAt=${JSON.stringify(detail.scheduledAt || "-")} preview=${JSON.stringify(detail.preview)} error=${JSON.stringify(detail.error)}`).join("\n")}`;
}
function classify(error: unknown): { code: PostErrorCode; message: string; retryable: boolean } {
  const message = safeError(error);
  if (error instanceof ThreadsApiError) {
    if (/190|401|AUTH/i.test(error.apiCode)) return { code: "AUTH_ERROR", message, retryable: false };
    if (/429|RATE|4$|32$|613$/.test(error.apiCode)) return { code: "RATE_LIMIT", message, retryable: true };
    return { code: "API_ERROR", message, retryable: true };
  }
  if (error instanceof TypeError) return { code: "NETWORK_ERROR", message, retryable: true };
  return { code: "UNKNOWN_ERROR", message, retryable: false };
}
export class ThreadsPostService {
  constructor(private readonly store: PostStore, private readonly api?: ThreadsPublishingApi, private readonly now: () => Date = () => new Date(), private readonly runStore?: PublisherRunStore) {}
  async addDraft(content: string, notes = "", source: PostQueueRecord["source"] = "manual", requestedScheduledAt = ""): Promise<PostQueueRecord> {
    await this.store.ensurePostSheets(); const value = validateContent(content), posts = await this.store.listPosts(), record=this.createDraftRecord(value,notes,source,requestedScheduledAt,posts);
    await this.store.upsertPost(record); return record;
  }
  private createDraftRecord(value:string,notes:string,source:PostQueueRecord["source"],requestedScheduledAt:string,posts:PostQueueRecord[]):PostQueueRecord{const duplicate=duplicateCheck(value,posts),timestamp=this.now().toISOString();return { postId: randomUUID(), platform: "threads", content: value, contentHash: contentHash(value), status: duplicate.exact ? "SKIPPED_DUPLICATE" : duplicate.near ? "REVIEW" : "DRAFT", scheduledAt: "", approvedAt: "", createdAt: timestamp, updatedAt: timestamp, publishedAt: "", threadsPostId: "", errorCode: duplicate.exact ? "DUPLICATE" : "", errorMessage: duplicate.exact ? "Exact duplicate blocked" : "", retryCount: 0, source, notes: duplicate.near ? [notes, "NEAR_DUPLICATE_WARNING"].filter(Boolean).join("; ") : notes, requestedScheduledAt };}
  async list(): Promise<PostQueueRecord[]> { await this.store.ensurePostSheets(); return this.store.listPosts(); }
  private transitionRecord(post:PostQueueRecord,status:PostStatus,changes:Partial<PostQueueRecord>={}):PostQueueRecord{assertTransition(post.status,status);return{...post,...changes,status,updatedAt:this.now().toISOString()};}
  private scheduleRecord(post:PostQueueRecord,scheduledAt:string,posts:PostQueueRecord[]):PostQueueRecord{if(!/(Z|[+-]\d{2}:\d{2})$/.test(scheduledAt)||!Number.isFinite(Date.parse(scheduledAt)))throw new Error("scheduledAt must be an ISO 8601 timestamp with timezone");const instant=Date.parse(scheduledAt);if(instant<=this.now().getTime())throw new Error("scheduledAt must be in the future");if(posts.some(candidate=>candidate.postId!==post.postId&&candidate.status==="SCHEDULED"&&Math.abs(Date.parse(candidate.scheduledAt)-instant)<POSTING_LIMITS.minimumIntervalMinutes*60000))throw new Error(`scheduledAt must be at least ${POSTING_LIMITS.minimumIntervalMinutes} minutes from another scheduled post`);return this.transitionRecord(post,"SCHEDULED",{scheduledAt:new Date(instant).toISOString()});}
  private async transition(postId: string, status: PostStatus, changes: Partial<PostQueueRecord> = {}): Promise<PostQueueRecord> { const post = await this.required(postId); assertTransition(post.status, status); const updated = { ...post, ...changes, status, updatedAt: this.now().toISOString() }; await this.store.upsertPost(updated); return updated; }
  async review(id: string) { return this.transition(id, "REVIEW"); }
  async approve(id: string) { return this.transition(id, "APPROVED", { approvedAt: this.now().toISOString(), errorCode: "", errorMessage: "" }); }
  async approveAll(options: { status?: PostStatus; ids?: string[] }): Promise<PostQueueRecord[]> { const posts = await this.list(), ids = new Set(options.ids ?? []), targets = posts.filter((post) => options.ids?.length ? ids.has(post.postId) : post.status === (options.status ?? "DRAFT")).filter((post) => post.status === "DRAFT"),timestamp=this.now().toISOString(),result=targets.map(post=>this.transitionRecord(post,"APPROVED",{approvedAt:timestamp,errorCode:"",errorMessage:""}));await this.store.updatePosts(result,posts);return result; }
  async cancel(id: string) { return this.transition(id, "CANCELLED"); }
  async schedule(id: string, scheduledAt: string): Promise<PostQueueRecord> {const posts=await this.list(),post=posts.find(candidate=>candidate.postId===id);if(!post)throw new Error("Post was not found");const updated=this.scheduleRecord(post,scheduledAt,posts);await this.store.updatePosts([updated],posts);return updated;}
  async importCandidates(rows: ImportCandidate[]): Promise<ImportSummary> { const summary:ImportSummary={read:rows.length,draft:0,review:0,duplicate:0,errors:0,errorDetails:[],posts:[]};await this.store.ensurePostSheets();const posts=await this.store.listPosts(),created:PostQueueRecord[]=[];for(const [index,row] of rows.entries()){try{if(row.scheduledAt&&(!/(Z|[+-]\d{2}:\d{2})$/.test(row.scheduledAt)||!Number.isFinite(Date.parse(row.scheduledAt))))throw new Error("invalid scheduledAt");const value=validateContent(row.content),hash=contentHash(value);if(posts.some(post=>post.contentHash===hash&&post.status!=="CANCELLED")){summary.duplicate++;continue;}const post=this.createDraftRecord(value,row.notes,"import",row.scheduledAt?new Date(row.scheduledAt).toISOString():"",posts);created.push(post);posts.push(post);summary.posts.push(post);if(post.status==="DRAFT")summary.draft++;else if(post.status==="REVIEW")summary.review++;else if(post.status==="SKIPPED_DUPLICATE")summary.duplicate++;}catch(error){summary.errors++;summary.errorDetails.push({row:index+1,preview:importPreview(row.content),scheduledAt:row.scheduledAt,error:safeImportError(error)});}}await this.store.appendPosts(created);return summary; }
  async cleanupImportDuplicates(apply=false):Promise<ImportDuplicateCleanupSummary>{await this.store.ensurePostSheets();const posts=await this.store.listPosts(),eligible=posts.filter((post):post is PostQueueRecord&{status:"DRAFT"|"REVIEW"}=>post.source==="import"&&(post.status==="DRAFT"||post.status==="REVIEW")),groups=new Map<string,typeof eligible>();for(const post of eligible){const group=groups.get(post.contentHash)??[];group.push(post);groups.set(post.contentHash,group);}const targets:ImportDuplicateCleanupTarget[]=[];let duplicateGroups=0;for(const group of groups.values()){if(group.length<2)continue;duplicateGroups++;group.sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.postId.localeCompare(b.postId));const kept=group[0]!;for(const duplicate of group.slice(1))targets.push({postId:duplicate.postId,keptPostId:kept.postId,status:duplicate.status,createdAt:duplicate.createdAt,contentHash:duplicate.contentHash});}if(apply){const targetIds=new Set(targets.map(target=>target.postId)),timestamp=this.now().toISOString(),updates=eligible.filter(post=>targetIds.has(post.postId)).map(post=>({...post,status:"CANCELLED" as const,updatedAt:timestamp,notes:[post.notes,"IMPORT_DUPLICATE_CLEANUP"].filter(Boolean).join("; ")}));await this.store.updatePosts(updates,posts);}return{apply,scanned:eligible.length,duplicateGroups,targets};}
  async scheduleImported(options:ScheduleImportedOptions={}):Promise<PostQueueRecord[]>{const posts=await this.list(),targets=posts.filter(post=>post.status==="APPROVED"&&post.requestedScheduledAt).sort((a,b)=>a.requestedScheduledAt.localeCompare(b.requestedScheduledAt)||a.createdAt.localeCompare(b.createdAt)),working=[...posts],result:PostQueueRecord[]=[],recent=new Map<PostingSlot,{date:string;minute:number}[]>();for(const post of targets){let scheduledAt=post.requestedScheduledAt;if(options.jitter){const slot=inferPostingSlot(post.requestedScheduledAt),{date}=jstDateTime(post.requestedScheduledAt),history=recent.get(slot)??[];const candidate=jitterCandidates(date,slot,post.postId).find(minute=>{const previous=history.at(-1),before=history.at(-2);if(previous?.date===date)return false;if(history.some(item=>item.minute===minute))return false;if(previous&&before&&Math.round((Date.parse(`${date}T00:00:00Z`)-Date.parse(`${before.date}T00:00:00Z`))/86400000)===2&&Math.abs(previous.minute-before.minute)<=5&&Math.abs(minute-previous.minute)<=5)return false;const instant=Date.parse(jstIso(date,minute));return instant>this.now().getTime()&&!working.some(candidate=>candidate.postId!==post.postId&&candidate.status==="SCHEDULED"&&Math.abs(Date.parse(candidate.scheduledAt)-instant)<POSTING_LIMITS.minimumIntervalMinutes*60000);});if(candidate===undefined)throw new Error(`No valid jitter time remains in ${slot} window for ${date}`);scheduledAt=jstIso(date,candidate);history.push({date,minute:candidate});recent.set(slot,history);}const updated=this.scheduleRecord(post,scheduledAt,working);result.push(updated);working[working.findIndex(candidate=>candidate.postId===post.postId)]=updated;}if(!options.dryRun)await this.store.updatePosts(result,posts);return result;}
  async scheduleBatch(start:string,times:string[]):Promise<PostQueueRecord[]>{if(!/(Z|[+-]\d{2}:\d{2})$/.test(start)||!Number.isFinite(Date.parse(start)))throw new Error("start must include timezone");const slots=times.map(x=>{if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(x))throw new Error("times must use HH:mm");return x;}).sort();if(!slots.length)throw new Error("times must not be empty");const posts=await this.list(),targets=posts.filter(p=>p.status==="APPROVED").sort((a,b)=>a.createdAt.localeCompare(b.createdAt)),working=[...posts],result:PostQueueRecord[]=[];let day=0,index=0;for(const post of targets){let candidate="";do{const d=new Date(`${start.slice(0,10)}T00:00:00Z`);d.setUTCDate(d.getUTCDate()+day);candidate=`${d.toISOString().slice(0,10)}T${slots[index]}:00+09:00`;index++;if(index>=slots.length){index=0;day++;}}while(Date.parse(candidate)<Date.parse(start));const updated=this.scheduleRecord(post,candidate,working);result.push(updated);working[working.findIndex(item=>item.postId===post.postId)]=updated;}await this.store.updatePosts(result,posts);return result;}
  private async required(id: string): Promise<PostQueueRecord> { await this.store.ensurePostSheets(); const post = await this.store.getPost(id); if (!post) throw new Error("Post was not found"); return post; }
  async dryRun(id: string): Promise<DryRunResult> {
    const post = await this.required(id), posts = await this.store.listPosts(), duplicate = duplicateCheck(post.content, posts, id); let tokenValid = false;
    try { if (this.api) { await this.api.getProfile(); tokenValid = true; } } catch { tokenValid = false; }
    const due = post.status !== "SCHEDULED" || Date.parse(post.scheduledAt) <= this.now().getTime(), publishable = ["APPROVED", "SCHEDULED"].includes(post.status) && due && !duplicate.exact && !post.threadsPostId && post.retryCount < POSTING_LIMITS.maxRetries && tokenValid;
    return { postId: post.postId, status: post.status, content: post.content, scheduledAt: post.scheduledAt, duplicate, publishable, tokenValid, reason: publishable ? "READY" : !tokenValid ? "TOKEN_INVALID" : duplicate.exact ? "DUPLICATE" : !due ? "NOT_DUE" : "STATUS_OR_IDEMPOTENCY_BLOCK" };
  }
  async publish(id: string): Promise<{ status: "PUBLISHED" | "SKIPPED" | "FAILED"; post: PostQueueRecord }> {
    const lock = await acquireDailyLock(`/tmp/creator-metrics-collector-threads-post-${id.replace(/[^A-Za-z0-9-]/g, "")}.lock`);
    try {
      let post = await this.required(id);
      if (post.status === "PUBLISHED" || post.threadsPostId) return { status: "SKIPPED", post };
      if (!["APPROVED", "SCHEDULED", "FAILED"].includes(post.status)) throw new Error(`Post status ${post.status} is not publishable`);
      if (post.status === "SCHEDULED" && Date.parse(post.scheduledAt) > this.now().getTime()) throw new Error("Scheduled post is not due");
      if (post.retryCount >= POSTING_LIMITS.maxRetries) throw new Error("Post retry limit reached");
      const duplicate = duplicateCheck(validateContent(post.content), await this.store.listPosts(), id); if (duplicate.exact) throw new Error("Exact duplicate blocked");
      if (!this.api) throw new Error("Threads publishing API is not configured");
      post = await this.transition(id, "PUBLISHING", { errorCode: "", errorMessage: "" });
      const attempt = post.retryCount + 1;
      try {
        await this.api.getProfile();
        const creationId = await this.api.createTextContainer(post.content), threadsPostId = await this.api.publishContainer(creationId), publishedAt = this.now().toISOString();
        post = await this.transition(id, "PUBLISHED", { threadsPostId, publishedAt, retryCount: attempt });
        await this.history(post, "PUBLISHED", attempt, ""); return { status: "PUBLISHED", post };
      } catch (error) {
        const failure = classify(error); post = await this.transition(id, "FAILED", { retryCount: attempt, errorCode: failure.code, errorMessage: failure.message }); await this.history(post, "FAILED", attempt, failure.code); return { status: "FAILED", post };
      }
    } finally { await lock.release(); }
  }
  private async history(post: PostQueueRecord, status: PostHistoryRecord["status"], attempt: number, errorCode: PostErrorCode) { const value: PostHistoryRecord = { historyId: randomUUID(), postId: post.postId, platform: "threads", contentHash: post.contentHash, scheduledAt: post.scheduledAt, publishedAt: post.publishedAt, status, threadsPostId: post.threadsPostId, attempt, errorCode, createdAt: this.now().toISOString() }; await this.store.appendHistory(value); }
  async publishDue(dryRun=false): Promise<DueSummary> { const startedAt=this.now().toISOString(),runId=randomUUID(),now=this.now().getTime(),due=(await this.list()).filter(p=>p.status==="SCHEDULED"&&Date.parse(p.scheduledAt)<=now).sort((a,b)=>a.scheduledAt.localeCompare(b.scheduledAt));const targets=due.map(post=>({postId:post.postId,action:(now-Date.parse(post.scheduledAt)>POSTING_LIMITS.maxOverdueMinutes*60000?"EXPIRE":"PUBLISH") as "EXPIRE"|"PUBLISH"}));const summary:DueSummary={dueCount:due.length,publishedCount:0,failedCount:0,expiredCount:0,skippedCount:0,dryRun,targets};if(!dryRun){for(const target of targets){const post=await this.required(target.postId);if(target.action==="EXPIRE"){const expired=await this.transition(post.postId,"EXPIRED",{errorCode:"VALIDATION_ERROR",errorMessage:`Exceeded maximum overdue window of ${POSTING_LIMITS.maxOverdueMinutes} minutes`});await this.history(expired,"EXPIRED",post.retryCount,expired.errorCode);summary.expiredCount++;continue;}try{const result=await this.publish(post.postId);if(result.status==="PUBLISHED")summary.publishedCount++;else if(result.status==="FAILED")summary.failedCount++;else summary.skippedCount++;}catch{summary.failedCount++;}}}const overallStatus:PublisherRunLogRecord["overallStatus"]=summary.dueCount===0?"NO_DUE":summary.failedCount?summary.publishedCount||summary.expiredCount?"PARTIAL":"FAILED":"SUCCESS";if(this.runStore)await this.runStore.appendPublisherRunLog({runId,startedAt,finishedAt:this.now().toISOString(),dueCount:summary.dueCount,publishedCount:summary.publishedCount,failedCount:summary.failedCount,expiredCount:summary.expiredCount,skippedCount:summary.skippedCount,overallStatus});return summary;}
}
