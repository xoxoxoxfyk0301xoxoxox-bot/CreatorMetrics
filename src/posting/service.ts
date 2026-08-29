import { randomUUID } from "node:crypto";
import { acquireDailyLock } from "../daily-lock.js";
import { safeError } from "../daily.js";
import { ThreadsApiError, type ThreadsPublishingApi } from "../threads-client.js";
import { contentHash, duplicateCheck, normalizeContent } from "./duplicate.js";
import { assertTransition } from "./state.js";
import type { PostErrorCode, PostHistoryRecord, PostQueueRecord, PostStatus, PostStore, PublisherRunLogRecord, PublisherRunStore } from "./types.js";

export const POSTING_LIMITS = { maxCharacters: 500, maxRetries: 3, minimumIntervalMinutes: 60, maxOverdueMinutes: 360 } as const;
export interface ImportCandidate { content: string; scheduledAt: string; notes: string }
export interface ImportSummary { read: number; draft: number; review: number; duplicate: number; errors: number; posts: PostQueueRecord[] }
export interface DueSummary { dueCount: number; publishedCount: number; failedCount: number; expiredCount: number; skippedCount: number; dryRun: boolean; targets: { postId: string; action: "PUBLISH" | "EXPIRE" }[] }
export interface DryRunResult { postId: string; status: PostStatus; content: string; scheduledAt: string; duplicate: { exact: boolean; near: boolean }; publishable: boolean; tokenValid: boolean; reason: string }
function validateContent(content: string): string { const value = normalizeContent(content); if (!value) throw new Error("Post content must not be empty"); if ([...value].length > POSTING_LIMITS.maxCharacters) throw new Error(`Post content exceeds ${POSTING_LIMITS.maxCharacters} characters`); return value; }
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
    await this.store.ensurePostSheets(); const value = validateContent(content), posts = await this.store.listPosts(), duplicate = duplicateCheck(value, posts), timestamp = this.now().toISOString();
    const record: PostQueueRecord = { postId: randomUUID(), platform: "threads", content: value, contentHash: contentHash(value), status: duplicate.exact ? "SKIPPED_DUPLICATE" : duplicate.near ? "REVIEW" : "DRAFT", scheduledAt: "", approvedAt: "", createdAt: timestamp, updatedAt: timestamp, publishedAt: "", threadsPostId: "", errorCode: duplicate.exact ? "DUPLICATE" : "", errorMessage: duplicate.exact ? "Exact duplicate blocked" : "", retryCount: 0, source, notes: duplicate.near ? [notes, "NEAR_DUPLICATE_WARNING"].filter(Boolean).join("; ") : notes, requestedScheduledAt };
    await this.store.upsertPost(record); return record;
  }
  async list(): Promise<PostQueueRecord[]> { await this.store.ensurePostSheets(); return this.store.listPosts(); }
  private async transition(postId: string, status: PostStatus, changes: Partial<PostQueueRecord> = {}): Promise<PostQueueRecord> { const post = await this.required(postId); assertTransition(post.status, status); const updated = { ...post, ...changes, status, updatedAt: this.now().toISOString() }; await this.store.upsertPost(updated); return updated; }
  async review(id: string) { return this.transition(id, "REVIEW"); }
  async approve(id: string) { return this.transition(id, "APPROVED", { approvedAt: this.now().toISOString(), errorCode: "", errorMessage: "" }); }
  async approveAll(options: { status?: PostStatus; ids?: string[] }): Promise<PostQueueRecord[]> { const posts = await this.list(), ids = new Set(options.ids ?? []), targets = posts.filter((post) => options.ids?.length ? ids.has(post.postId) : post.status === (options.status ?? "DRAFT")).filter((post) => post.status === "DRAFT"); const result=[]; for(const post of targets) result.push(await this.approve(post.postId)); return result; }
  async cancel(id: string) { return this.transition(id, "CANCELLED"); }
  async schedule(id: string, scheduledAt: string): Promise<PostQueueRecord> { if (!/(Z|[+-]\d{2}:\d{2})$/.test(scheduledAt) || !Number.isFinite(Date.parse(scheduledAt))) throw new Error("scheduledAt must be an ISO 8601 timestamp with timezone"); const instant=Date.parse(scheduledAt); if(instant<=this.now().getTime()) throw new Error("scheduledAt must be in the future"); const posts=await this.list(); if(posts.some((p)=>p.postId!==id&&p.status==="SCHEDULED"&&Math.abs(Date.parse(p.scheduledAt)-instant)<POSTING_LIMITS.minimumIntervalMinutes*60000)) throw new Error(`scheduledAt must be at least ${POSTING_LIMITS.minimumIntervalMinutes} minutes from another scheduled post`); return this.transition(id, "SCHEDULED", { scheduledAt: new Date(instant).toISOString() }); }
  async importCandidates(rows: ImportCandidate[]): Promise<ImportSummary> { const summary:ImportSummary={read:rows.length,draft:0,review:0,duplicate:0,errors:0,posts:[]}; for(const row of rows){try{if(row.scheduledAt&&(!/(Z|[+-]\d{2}:\d{2})$/.test(row.scheduledAt)||!Number.isFinite(Date.parse(row.scheduledAt))))throw new Error("invalid scheduledAt");const post=await this.addDraft(row.content,row.notes,"import",row.scheduledAt?new Date(row.scheduledAt).toISOString():"");summary.posts.push(post);if(post.status==="DRAFT")summary.draft++;else if(post.status==="REVIEW")summary.review++;else if(post.status==="SKIPPED_DUPLICATE")summary.duplicate++;}catch{summary.errors++;}} return summary; }
  async scheduleImported():Promise<PostQueueRecord[]>{const posts=(await this.list()).filter(p=>p.status==="APPROVED"&&p.requestedScheduledAt).sort((a,b)=>a.createdAt.localeCompare(b.createdAt));const result=[];for(const post of posts)result.push(await this.schedule(post.postId,post.requestedScheduledAt));return result;}
  async scheduleBatch(start:string,times:string[]):Promise<PostQueueRecord[]>{if(!/(Z|[+-]\d{2}:\d{2})$/.test(start)||!Number.isFinite(Date.parse(start)))throw new Error("start must include timezone");const slots=times.map(x=>{if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(x))throw new Error("times must use HH:mm");return x;}).sort();const posts=(await this.list()).filter(p=>p.status==="APPROVED").sort((a,b)=>a.createdAt.localeCompare(b.createdAt));const result=[];let day=0,index=0;for(const post of posts){let candidate="";do{const d=new Date(`${start.slice(0,10)}T00:00:00Z`);d.setUTCDate(d.getUTCDate()+day);candidate=`${d.toISOString().slice(0,10)}T${slots[index]}:00+09:00`;index++;if(index>=slots.length){index=0;day++;}}while(Date.parse(candidate)<Date.parse(start));result.push(await this.schedule(post.postId,candidate));}return result;}
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
