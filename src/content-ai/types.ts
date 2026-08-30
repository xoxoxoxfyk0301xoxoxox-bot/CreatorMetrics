import type { PostQueueRecord } from "../posting/types.js";

export type DuplicateStatus = "UNIQUE" | "POSSIBLE_DUPLICATE" | "DUPLICATE";
export type PerformanceTier = "HIGH" | "NORMAL" | "LOW" | "INSUFFICIENT_DATA";
export type PlanStatus = "PLANNED" | "GENERATED" | "REJECTED" | "SKIPPED_DUPLICATE";
export interface ContentStrategy { language:string; voice:string; audience:string[]; contentPillars:string[]; avoidTopics:string[]; styleRules:string[]; publicDisclosureRules:string[]; verifiedFacts:string[] }
export interface ContentPlanRecord { planId:string; targetDate:string; slot:string; contentPillar:string; coreTheme:string; angle:string; goal:string; hookIdea:string; status:PlanStatus; generatedPostId:string; createdAt:string; updatedAt:string; notes:string; regenerationCount:number }
export interface ContentLedgerRecord { contentId:string; postId:string; platform:"threads"; createdAt:string; publishedAt:string; status:string; coreTheme:string; claim:string; readerValue:string; advice:string; contentPillar:string; angle:string; hookType:string; contentSummary:string; sourceType:string; performanceTier:PerformanceTier; notes:string }
export interface ContentAIRunLog { runId:string; startedAt:string; finishedAt:string; provider:string; model:string; operation:string; requestedCount:number; generatedCount:number; uniqueCount:number; reviewCount:number; duplicateCount:number; failedCount:number; estimatedInputTokens:number; estimatedOutputTokens:number; status:"SUCCESS"|"PARTIAL"|"FAILED"|"DRY_RUN"; createdAt:string }
export interface PlanSeed { targetDate:string; slot:string; contentPillar:string }
export interface DraftCandidate { content:string; coreTheme:string; claim:string; readerValue:string; advice:string; angle:string; hookType:string; contentSummary:string }
export interface DuplicateReview { status:DuplicateStatus; matchedContentId:string; reason:string }
export interface AIContext { strategy:ContentStrategy; ledger:ContentLedgerRecord[]; scheduled:PostQueueRecord[]; performanceSummary:string }
export interface ContentAIProvider { readonly name:string; readonly model:string; generatePlan(seeds:PlanSeed[],context:AIContext):Promise<Omit<ContentPlanRecord,"planId"|"status"|"generatedPostId"|"createdAt"|"updatedAt"|"notes"|"regenerationCount">[]>; generateDraft(plan:ContentPlanRecord,context:AIContext):Promise<DraftCandidate>; reviewDuplicate(candidate:DraftCandidate,ledger:ContentLedgerRecord[]):Promise<DuplicateReview> }
export interface ContentStore { ensureContentSheets():Promise<void>; listPlans():Promise<ContentPlanRecord[]>; upsertPlan(record:ContentPlanRecord):Promise<void>; listLedger():Promise<ContentLedgerRecord[]>; upsertLedger(record:ContentLedgerRecord):Promise<void>; appendRunLog(record:ContentAIRunLog):Promise<void>; readThreadsPerformance():Promise<{contentId:string;views:number;likes:number;replies:number;reposts:number}[]> }
