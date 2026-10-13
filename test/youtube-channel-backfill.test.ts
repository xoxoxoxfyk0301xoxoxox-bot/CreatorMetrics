import {describe,expect,it,vi} from "vitest";
import type {Auth} from "googleapis";
import {fetchYouTubeChannelBackfill,YOUTUBE_REPORTING_TIME_ZONE} from "../src/youtube-channel-backfill.js";

vi.mock("googleapis",()=>({google:{youtube:()=>({channels:{list:async()=>({data:{items:[{id:"channel"}]}})}}),youtubeAnalytics:()=>({reports:{query:async()=>({data:{columnHeaders:[{name:"day"},{name:"views"},{name:"estimatedMinutesWatched"},{name:"subscribersGained"},{name:"subscribersLost"}],rows:[["2026-06-08",10,3,2,1],["2026-06-10",0,0,0,0]]}})}})}}));

describe("YouTube channel backfill",()=>{
  it("keeps returned zeroes but does not invent a missing day",async()=>{const result=await fetchYouTubeChannelBackfill({} as Auth.OAuth2Client,"2026-06-08","2026-06-10");expect(result.successfulDays).toBe(2);expect(result.missingDays).toEqual(["2026-06-09"]);expect(result.records[1]?.metrics.views).toBe(0);expect(result.totals).toEqual({views:10,estimatedMinutesWatched:3,subscribersGained:2,subscribersLost:1});expect(result.reportingTimeZone).toBe(YOUTUBE_REPORTING_TIME_ZONE);});
});
