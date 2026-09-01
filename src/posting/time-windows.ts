import { createHash } from "node:crypto";

export type PostingSlot = "morning" | "noon" | "night";
export interface PostingTimeWindow { start: string; end: string; label: string; legacyHours: number[] }
export const POSTING_TIME_RULE = {
  timeZone: "Asia/Tokyo",
  windows: {
    morning: { start: "07:40", end: "08:20", label: "朝", legacyHours: [8] },
    noon: { start: "11:40", end: "12:30", label: "昼", legacyHours: [12] },
    night: { start: "22:30", end: "23:30", label: "夜", legacyHours: [21] }
  } satisfies Record<PostingSlot, PostingTimeWindow>
} as const;

function minuteOfDay(value:string):number{const [hour,minute]=value.split(":").map(Number);return hour!*60+minute!;}
export function jstDateTime(iso:string):{date:string;time:string}{const parts=new Intl.DateTimeFormat("en-CA",{timeZone:POSTING_TIME_RULE.timeZone,year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).formatToParts(new Date(iso)),get=(type:string)=>parts.find(part=>part.type===type)?.value??"";return{date:`${get("year")}-${get("month")}-${get("day")}`,time:`${get("hour")}:${get("minute")}`};}
export function inferPostingSlot(iso:string):PostingSlot{const {time}=jstDateTime(iso),minute=minuteOfDay(time),hour=Math.floor(minute/60);for(const slot of Object.keys(POSTING_TIME_RULE.windows) as PostingSlot[]){const window=POSTING_TIME_RULE.windows[slot];if((minute>=minuteOfDay(window.start)&&minute<=minuteOfDay(window.end))||window.legacyHours.includes(hour))return slot;}throw new Error(`requestedScheduledAt does not map to a posting slot: ${time} JST`);}
export function jitterCandidates(date:string,slot:PostingSlot,postId:string):number[]{const window=POSTING_TIME_RULE.windows[slot],start=minuteOfDay(window.start),end=minuteOfDay(window.end),size=end-start+1,seed=createHash("sha256").update(`${date}|${slot}|${postId}`).digest().readUInt32BE(0),result:number[]=[];for(let attempt=0;attempt<size;attempt++)result.push(start+((seed+attempt*19)%size));return result;}
export function jstIso(date:string,minuteOfDayValue:number):string{const hour=Math.floor(minuteOfDayValue/60),minute=minuteOfDayValue%60;return `${date}T${String(hour).padStart(2,"0")}:${String(minute).padStart(2,"0")}:00+09:00`;}
