import { dateInTimeZone } from "../date.js";
import { buildPostingDashboard } from "./analytics.js";
import type { PostingDashboardDataSource,PostingDashboardSink } from "./types.js";
export async function runPostingDashboard(source:PostingDashboardDataSource,sink:PostingDashboardSink,asOf=dateInTimeZone(new Date(),"Asia/Tokyo"),now=new Date()){const output=buildPostingDashboard(await source.readPostingData(),asOf,now);await sink.writePostingDashboard(output);return output;}
