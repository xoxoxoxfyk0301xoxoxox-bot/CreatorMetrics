import { randomUUID } from "node:crypto";
import { duplicateCheck } from "../posting/duplicate.js";
import { ThreadsPostService } from "../posting/service.js";
import type { PostStore } from "../posting/types.js";
import { deterministicDuplicate } from "./duplicate-reviewer.js";
import { CONTENT_LIMITS, materializePlans, planSeeds } from "./planner.js";
import { redactAIError, validatePublicDraft } from "./safety.js";
import type { AIContext, ContentAIProvider, ContentAIRunLog, ContentLedgerRecord, ContentPlanRecord, ContentStore, ContentStrategy, DraftCandidate, DuplicateReview, PerformanceTier } from "./types.js";

const rank = { UNIQUE: 0, POSSIBLE_DUPLICATE: 1, DUPLICATE: 2 } as const;
export class ThreadsContentService {
  private postService: ThreadsPostService;
  constructor(private store: ContentStore, private posts: PostStore, private provider: ContentAIProvider, private strategy: ContentStrategy, private now = () => new Date()) { this.postService = new ThreadsPostService(posts, undefined, now); }
  private tiers(values: number[]) { const sorted = values.filter(Number.isFinite).sort((a, b) => a - b); return (value: number | null): PerformanceTier => { if (value === null || sorted.length < 5) return "INSUFFICIENT_DATA"; const ratio = value / (sorted.at(-1) || 1); return ratio >= .75 ? "HIGH" : ratio <= .25 ? "LOW" : "NORMAL"; }; }
  private async context(): Promise<AIContext> {
    await this.store.ensureContentSheets(); const posts = await this.postService.list(), performance = await this.store.readThreadsPerformance(), ledger = await this.store.listLedger();
    const latest = new Map<string, number>(); for (const row of performance) latest.set(row.contentId, Math.max(latest.get(row.contentId) ?? 0, row.views)); const tier = this.tiers([...latest.values()]);
    for (const post of posts.filter((row) => ["DRAFT", "REVIEW", "APPROVED", "SCHEDULED", "PUBLISHED", "CANCELLED"].includes(row.status))) {
      const contentId = post.threadsPostId || post.postId; if (ledger.some((row) => row.contentId === contentId)) continue;
      const record: ContentLedgerRecord = { contentId, postId: post.postId, platform: "threads", createdAt: post.createdAt, publishedAt: post.publishedAt, status: post.status, coreTheme: post.content.slice(0, 80), claim: post.content.slice(0, 160), readerValue: "", advice: "", contentPillar: "未分類", angle: "", hookType: "", contentSummary: post.content.slice(0, 160), sourceType: post.source, performanceTier: tier(latest.get(post.threadsPostId || "") ?? null), notes: "Phase 1/2 queue sync; axes require enrichment" };
      await this.store.upsertLedger(record); ledger.push(record);
    }
    return { strategy: this.strategy, ledger, scheduled: posts.filter((row) => row.status === "SCHEDULED"), performanceSummary: performance.length < 5 ? "INSUFFICIENT_DATA" : `Threads content snapshots=${performance.length}; performance is theme context only` };
  }
  async createPlan(days: number, postsPerDay: number, dryRun = false) {
    const started = this.now(), context = await this.context(), seeds = planSeeds(days, postsPerDay, this.strategy, started);
    const values = dryRun ? seeds.map((seed) => ({ ...seed, coreTheme: `${seed.contentPillar}の新しい切り口`, angle: "具体的な気づき", goal: "読者が小さく試せる視点を得る", hookIdea: "身近な場面から始める" })) : await this.provider.generatePlan(seeds, context);
    const plans = materializePlans(values, started); if (!dryRun) for (const plan of plans) await this.store.upsertPlan(plan); await this.log(started, "PLAN", seeds.length, plans.length, 0, 0, 0, 0, dryRun); return plans;
  }
  async generate(options: { planId?: string; count?: number; dryRun?: boolean }) {
    const started = this.now(), count = options.count ?? 5; if (!Number.isInteger(count) || count < 1 || count > CONTENT_LIMITS.maxPerRun) throw new Error(`count must be 1..${CONTENT_LIMITS.maxPerRun}`);
    const context = await this.context(), plans = (await this.store.listPlans()).filter((row) => row.status === "PLANNED" && (!options.planId || row.planId === options.planId)).slice(0, count);
    const result: { plan: ContentPlanRecord; candidate?: DraftCandidate; duplicate?: DuplicateReview; postId?: string; errors: string[] }[] = []; let unique = 0, review = 0, duplicate = 0, failed = 0;
    for (const plan of plans) { try {
      const candidate = await this.provider.generateDraft(plan, context), errors = validatePublicDraft(candidate.content, this.strategy); if (errors.length) { failed++; result.push({ plan, candidate, errors }); continue; }
      const local = deterministicDuplicate(candidate, context.ledger), ai = local.status === "DUPLICATE" ? local : await this.provider.reviewDuplicate(candidate, context.ledger), decision = rank[local.status] >= rank[ai.status] ? local : ai, exact = duplicateCheck(candidate.content, await this.posts.listPosts()).exact;
      if (decision.status === "DUPLICATE" || exact) { const blocked: DuplicateReview = exact ? { status: "DUPLICATE", matchedContentId: "", reason: "Exact text duplicate" } : decision; duplicate++; if (!options.dryRun) await this.store.upsertPlan({ ...plan, status: "SKIPPED_DUPLICATE", updatedAt: this.now().toISOString(), notes: blocked.reason }); result.push({ plan, candidate, duplicate: blocked, errors: [] }); continue; }
      if (options.dryRun) { decision.status === "UNIQUE" ? unique++ : review++; result.push({ plan, candidate, duplicate: decision, errors: [] }); continue; }
      let post = await this.postService.addDraft(candidate.content, `planId=${plan.planId}; semantic=${decision.status}; matched=${decision.matchedContentId}; reason=${decision.reason}`, "AI_CONTENT_PHASE3"); if (decision.status === "POSSIBLE_DUPLICATE" && post.status === "DRAFT") post = await this.postService.review(post.postId); post.status === "DRAFT" ? unique++ : review++;
      const ledger: ContentLedgerRecord = { contentId: post.postId, postId: post.postId, platform: "threads", createdAt: post.createdAt, publishedAt: "", status: post.status, coreTheme: candidate.coreTheme, claim: candidate.claim, readerValue: candidate.readerValue, advice: candidate.advice, contentPillar: plan.contentPillar, angle: candidate.angle, hookType: candidate.hookType, contentSummary: candidate.contentSummary, sourceType: "AI_CONTENT_PHASE3", performanceTier: "INSUFFICIENT_DATA", notes: `planId=${plan.planId}` };
      await this.store.upsertLedger(ledger); context.ledger.push(ledger); await this.store.upsertPlan({ ...plan, status: "GENERATED", generatedPostId: post.postId, updatedAt: this.now().toISOString() }); result.push({ plan, candidate, duplicate: decision, postId: post.postId, errors: [] });
    } catch (error) { failed++; result.push({ plan, errors: [redactAIError(error)] }); } }
    await this.log(started, "GENERATE", plans.length, result.filter((row) => row.candidate).length, unique, review, duplicate, failed, !!options.dryRun); return result;
  }
  async reject(planId: string) { const plan = (await this.store.listPlans()).find((row) => row.planId === planId); if (!plan) throw new Error("Plan not found"); if (plan.generatedPostId) { const post = await this.posts.getPost(plan.generatedPostId); if (post && ["DRAFT", "REVIEW"].includes(post.status)) await this.postService.cancel(post.postId); } const updated = { ...plan, status: "REJECTED" as const, updatedAt: this.now().toISOString() }; await this.store.upsertPlan(updated); return updated; }
  async regenerate(planId: string, dryRun = false) { const old = (await this.store.listPlans()).find((row) => row.planId === planId); if (!old) throw new Error("Plan not found"); if (old.regenerationCount >= CONTENT_LIMITS.maxRegenerations) throw new Error("Regeneration limit reached"); await this.reject(planId); const updated = { ...old, status: "PLANNED" as const, generatedPostId: "", regenerationCount: old.regenerationCount + 1, updatedAt: this.now().toISOString(), notes: `regenerated from rejected draft ${old.generatedPostId}` }; await this.store.upsertPlan(updated); return this.generate({ planId, count: 1, dryRun }); }
  private async log(started: Date, operation: string, requested: number, generated: number, unique: number, review: number, duplicate: number, failed: number, dryRun: boolean) { const finished = this.now(); const record: ContentAIRunLog = { runId: randomUUID(), startedAt: started.toISOString(), finishedAt: finished.toISOString(), provider: this.provider.name, model: this.provider.model, operation, requestedCount: requested, generatedCount: generated, uniqueCount: unique, reviewCount: review, duplicateCount: duplicate, failedCount: failed, estimatedInputTokens: Math.ceil(JSON.stringify(this.strategy).length / 4), estimatedOutputTokens: generated * 250, status: dryRun ? "DRY_RUN" : failed ? (generated ? "PARTIAL" : "FAILED") : "SUCCESS", createdAt: finished.toISOString() }; await this.store.appendRunLog(record); }
}
