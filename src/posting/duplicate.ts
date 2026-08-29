import { createHash } from "node:crypto";
import type { PostQueueRecord } from "./types.js";

export function normalizeContent(value: string): string { return value.replace(/\r\n?/g, "\n").trim().replace(/[ \t]+/g, " "); }
export function contentHash(value: string): string { return createHash("sha256").update(normalizeContent(value)).digest("hex"); }
function loose(value: string): string { return normalizeContent(value).replace(/https?:\/\/\S+/gi, "").replace(/(^|\s)#[^\s#]+/g, " ").replace(/\s+/g, " ").trim().toLowerCase(); }
function bigrams(value: string): Set<string> { const result = new Set<string>(); for (let i = 0; i < value.length - 1; i++) result.add(value.slice(i, i + 2)); return result; }
function similarity(a: string, b: string): number { if (a === b) return 1; const aa = bigrams(a), bb = bigrams(b); if (!aa.size || !bb.size) return 0; const common = [...aa].filter((item) => bb.has(item)).length; return 2 * common / (aa.size + bb.size); }
export function duplicateCheck(content: string, posts: PostQueueRecord[], excludePostId = ""): { exact: boolean; near: boolean } {
  const hash = contentHash(content), normalized = loose(content);
  const active = posts.filter((post) => post.postId !== excludePostId && ["APPROVED", "SCHEDULED", "PUBLISHING", "PUBLISHED"].includes(post.status));
  return { exact: active.some((post) => post.contentHash === hash), near: posts.some((post) => post.postId !== excludePostId && !["CANCELLED", "SKIPPED_DUPLICATE"].includes(post.status) && (loose(post.content) === normalized || similarity(loose(post.content), normalized) >= 0.9)) };
}
