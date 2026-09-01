import { describe, expect, it } from "vitest";
import { inferPostingSlot, jitterCandidates, jstDateTime, POSTING_TIME_RULE } from "../src/posting/time-windows.js";

const bounds={morning:["07:40","08:20"],noon:["11:40","12:30"],night:["22:30","23:30"]} as const;
describe("Threads posting time windows",()=>{
  it.each(["morning","noon","night"] as const)("keeps deterministic %s jitter inside its configured window",slot=>{const first=jitterCandidates("2026-09-08",slot,"post-1"),second=jitterCandidates("2026-09-08",slot,"post-1"),toTime=(minute:number)=>`${String(Math.floor(minute/60)).padStart(2,"0")}:${String(minute%60).padStart(2,"0")}`;expect(first).toEqual(second);expect(toTime(first[0]! )>=bounds[slot][0]).toBe(true);expect(toTime(first[0]! )<=bounds[slot][1]).toBe(true);});
  it("maps legacy 08:00, 12:00 and 21:00 JST to the formal slots",()=>{expect(inferPostingSlot("2026-09-08T08:00:00+09:00")).toBe("morning");expect(inferPostingSlot("2026-09-08T12:00:00+09:00")).toBe("noon");expect(inferPostingSlot("2026-09-08T21:00:00+09:00")).toBe("night");expect(POSTING_TIME_RULE.timeZone).toBe("Asia/Tokyo");});
  it("formats generated instants in Asia/Tokyo",()=>{expect(jstDateTime("2026-09-07T23:00:00.000Z")).toEqual({date:"2026-09-08",time:"08:00"});});
});
