import type { ContentStrategy } from "./types.js";
const INTERNAL=[/自動投稿/i,/投稿.*自動化/i,/\bAPI\b/i,/launchd/i,/scheduler/i,/collector/i,/access.?token/i,/refresh.?token/i,/oauth/i,/secret/i,/github/i,/投稿queue/i,/テスト投稿/i,/APIテスト/i];
const ACHIEVEMENT=[/(月|売上|収益|利益)\s*[0-9０-９,.]+\s*万?円/,/フォロワー.{0,8}[0-9０-９,.]+(人|倍|%)/,/売上.{0,8}[0-9０-９,.]+倍/,/毎日.{0,8}[0-9０-９,.]+時間/];
export function validatePublicDraft(content:string,strategy:ContentStrategy):string[]{const errors:string[]=[];if(INTERNAL.some(x=>x.test(content)))errors.push("PUBLIC_DISCLOSURE_BLOCKED");if(ACHIEVEMENT.some(x=>x.test(content))&&!strategy.verifiedFacts.some(f=>content.includes(f)))errors.push("UNVERIFIED_ACHIEVEMENT");if([...content].length>500)errors.push("TOO_LONG");return errors;}
export function redactAIError(error:unknown):string{const message=error instanceof Error?error.message:String(error);return message.replace(/(sk-[A-Za-z0-9_-]{8,}|Bearer\s+\S+|OPENAI_API_KEY\s*[=:]\s*\S+)/gi,"[REDACTED]").slice(0,300);}
