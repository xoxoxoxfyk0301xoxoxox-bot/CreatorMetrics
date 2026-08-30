import type { ContentAIProvider } from "./types.js";
const blocked=async():Promise<never>=>{throw new Error("Dry-run provider must not call an AI API");};
export function createNoCallProvider(model:string):ContentAIProvider{return{name:"openai",model,generatePlan:blocked,generateDraft:blocked,reviewDuplicate:blocked};}
