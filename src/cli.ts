import { createServer } from "node:http";
import { writeFile } from "node:fs/promises";
import { URL } from "node:url";
import { google } from "googleapis";
import { loadConfig, loadPinterestConfig, loadThreadsConfig, loadThreadsOAuthConfig, loadYouTubeConfig } from "./config.js";
import { assertIsoDate, yesterdayInTimeZone } from "./date.js";
import { createGoogleAuth, GOOGLE_SCOPES } from "./google-auth.js";
import { YouTubeAdapter } from "./adapters/youtube.js";
import { PinterestAdapter } from "./adapters/pinterest.js";
import { ThreadsAdapter } from "./adapters/threads.js";
import { initializeAdapterAsync } from "./adapters/unavailable.js";
import { ThreadsClient } from "./threads-client.js";
import { authorizeThreads, refreshThreadsTokenIfNeeded } from "./threads-auth.js";
import { GoogleSheetsStore } from "./store/google-sheets.js";
import { runCollection } from "./collector.js";
import { CsvImportEngine } from "./import/engine.js";
import { LocalInboxFileSource } from "./import/file-source.js";
import { dateInTimeZone } from "./date.js";
import { runDashboard } from "./dashboard/index.js";
import { GoogleSheetsDashboardStore } from "./dashboard/google-sheets.js";
import { printDailySummary, runDaily } from "./daily.js";
import { GoogleSheetsDailyRunLogStore } from "./store/daily-run-log.js";
import { acquireDailyLock } from "./daily-lock.js";
import { generateReport } from "./report/generator.js";
import { runReport } from "./report/index.js";
import { GoogleSheetsReportStore } from "./report/google-sheets.js";
import { GoogleSheetsPostStore } from "./posting/google-sheets.js";
import { ThreadsPostService } from "./posting/service.js";
import { readPostCandidates } from "./posting/batch.js";

type SelectedPlatform = "youtube" | "pinterest" | "threads";

async function collect(platforms: SelectedPlatform[]): Promise<void> {
  const config = loadConfig();
  const date = assertIsoDate(config.collectionDate ?? yesterdayInTimeZone(new Date(), config.timeZone));
  const auth = createGoogleAuth(config.google);
  const adapters = await Promise.all(platforms.map((platform) => initializeAdapterAsync(platform, async () => {
    if (platform === "youtube") {
      const youtube = loadYouTubeConfig();
      return new YouTubeAdapter(auth, youtube.channelId);
    }
    if (platform === "pinterest") {
      const pinterest = loadPinterestConfig();
      return new PinterestAdapter(pinterest.accessToken, pinterest.username, pinterest.baseUrl);
    }
    const threads = loadThreadsConfig();
    const accessToken = await refreshThreadsTokenIfNeeded(threads);
    return new ThreadsAdapter(new ThreadsClient(accessToken, threads.baseUrl), threads.lookbackDays);
  })));
  const store = new GoogleSheetsStore(auth, config.google.sheetId, config.google.metricsSheet, config.google.logSheet, config.google.contentSheet);
  const results = await runCollection(adapters, store, { date, timeZone: config.timeZone });
  for (const result of results) {
    const name = result.platform === "youtube" ? "YouTube" : result.platform === "pinterest" ? "Pinterest" : result.platform === "threads" ? "Threads" : result.platform;
    console.log(`${name}:`);
    console.log(`dailyMetrics: ${result.dailyMetrics}`);
    console.log(`contentMetrics: ${result.contentMetrics}`);
    console.log(`writtenDaily: ${result.writtenDaily}`);
    console.log(`writtenContent: ${result.writtenContent}`);
    if (result.reason) console.log(`reason: ${result.reason}`);
    if (result.error) console.error(`error: ${result.error}`);
  }
  if (results.every((result) => result.status === "failed")) process.exitCode = 1;
}

async function diagnoseThreads(): Promise<void> {
  try {
    const timeZone = process.env.TZ?.trim();
    if (!timeZone) throw new Error("Missing required environment variable: TZ");
    const date = assertIsoDate(process.env.COLLECTION_DATE?.trim() || yesterdayInTimeZone(new Date(), timeZone));
    const config = loadThreadsConfig();
    const accessToken = await refreshThreadsTokenIfNeeded(config);
    const result = await new ThreadsAdapter(new ThreadsClient(accessToken, config.baseUrl), config.lookbackDays).diagnose({ date, timeZone });
    console.log(`[Threads Diagnostics] ${JSON.stringify(result)}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[Threads Diagnostics] BLOCKED: ${message}`);
    process.exitCode = 1;
  }
}

async function diagnoseYouTube(): Promise<void> {
  const config = loadConfig();
  const date = assertIsoDate(config.collectionDate ?? yesterdayInTimeZone(new Date(), config.timeZone));
  const auth = createGoogleAuth(config.google);
  const youtube = loadYouTubeConfig();
  const result = await new YouTubeAdapter(auth, youtube.channelId).diagnose(date);
  console.log(`[YouTube Diagnostics] summary=${JSON.stringify(result)}`);
}

async function authorizeGoogle(): Promise<void> {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  const redirectUri = process.env.GOOGLE_REDIRECT_URI?.trim() || "http://localhost:3000/oauth2callback";
  if (!clientId || !clientSecret) throw new Error("Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET first");
  const auth = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  const url = auth.generateAuthUrl({ access_type: "offline", prompt: "consent", scope: GOOGLE_SCOPES });
  const redirect = new URL(redirectUri);
  if (redirect.hostname !== "localhost" && redirect.hostname !== "127.0.0.1") {
    console.log(`Open this URL, then set GOOGLE_REFRESH_TOKEN from the OAuth token exchange:\n${url}`);
    return;
  }
  console.log(`Open this URL in a browser:\n${url}`);
  await new Promise<void>((resolve, reject) => {
    const server = createServer(async (request, response) => {
      try {
        const requestUrl = new URL(request.url ?? "/", redirectUri);
        const code = requestUrl.searchParams.get("code");
        if (!code) throw new Error(requestUrl.searchParams.get("error") ?? "Missing OAuth authorization code");
        const { tokens } = await auth.getToken(code);
        response.end("Authorization complete. You can close this window.");
        server.close();
        if (!tokens.refresh_token) throw new Error("No refresh token returned; revoke prior consent and retry with prompt=consent");
        const tokenPath = ".google-refresh-token";
        await writeFile(tokenPath, `${tokens.refresh_token}\n`, { encoding: "utf8", mode: 0o600, flag: "w" });
        console.log(`\nRefresh token was saved to ${tokenPath} with owner-only permissions. Copy it to GOOGLE_REFRESH_TOKEN in your local .env, then delete the token file.`);
        resolve();
      } catch (error) { response.statusCode = 500; response.end("Authorization failed."); server.close(); reject(error); }
    });
    server.listen(Number(redirect.port || 80), redirect.hostname);
  });
}

async function importCsv(platform?: "note" | "rakuten"): Promise<void> {
  const config = loadConfig();
  const auth = createGoogleAuth(config.google);
  const directories = platform === "note" ? ["data/import/note"] : platform === "rakuten" ? ["data/import/rakuten"] : ["data/import/note", "data/import/rakuten"];
  const store = new GoogleSheetsStore(auth, config.google.sheetId, config.google.metricsSheet, config.google.logSheet, config.google.contentSheet);
  const results = await new CsvImportEngine(new LocalInboxFileSource(directories), store).run();
  if (!results.length) console.log(`No CSV files found in: ${directories.join(", ")}`);
  for (const result of results) {
    console.log(`${result.filename}: ${result.status} platform=${result.platform} source=${result.source} rowsRead=${result.rowsRead} rowsWritten=${result.rowsWritten} rowsUpdated=${result.rowsUpdated} rowsSkipped=${result.rowsSkipped}`);
    if (result.errorMessage) console.error(`error: ${result.errorMessage}`);
  }
  if (results.some((result) => result.status === "failed")) process.exitCode = 1;
}

async function dashboard(): Promise<void> {
  const config = loadConfig();
  const requestedDate = process.env.DASHBOARD_DATE?.trim();
  const asOf = assertIsoDate(requestedDate || dateInTimeZone(new Date(Date.now() - 86400000), config.timeZone));
  const auth = createGoogleAuth(config.google);
  const store = new GoogleSheetsDashboardStore(auth, config.google.sheetId);
  const output = await runDashboard(store, store, asOf);
  console.log(`Dashboard generated: asOf=${asOf} weeklyRows=${output.weekly.length} topContentRows=${output.topContent.length}`);
}

async function report(): Promise<void> {
  const config = loadConfig();
  const auth = createGoogleAuth(config.google);
  const store = new GoogleSheetsReportStore(auth, config.google.sheetId);
  const result = await runReport(store, store);
  console.log(`Report generated: period=${result.periodStart}..${result.periodEnd} lines=${result.lines.length}`);
}

async function daily(): Promise<void> {
  const lock = await acquireDailyLock();
  try {
  const config = loadConfig();
  const referenceDate = assertIsoDate(config.collectionDate ?? yesterdayInTimeZone(new Date(), config.timeZone));
  const auth = createGoogleAuth(config.google);
  const metricsStore = new GoogleSheetsStore(auth, config.google.sheetId, config.google.metricsSheet, config.google.logSheet, config.google.contentSheet);
  const dashboardStore = new GoogleSheetsDashboardStore(auth, config.google.sheetId);
  const reportStore = new GoogleSheetsReportStore(auth, config.google.sheetId);
  const collectPlatform = async (platform: "youtube" | "threads") => {
    const adapter = await initializeAdapterAsync(platform, async () => {
      if (platform === "youtube") return new YouTubeAdapter(auth, loadYouTubeConfig().channelId);
      const threads = loadThreadsConfig();
      return new ThreadsAdapter(new ThreadsClient(await refreshThreadsTokenIfNeeded(threads), threads.baseUrl), threads.lookbackDays);
    });
    const [result] = await runCollection([adapter], metricsStore, { date: referenceDate, timeZone: config.timeZone });
    if (!result) throw new Error(`${platform} collection returned no result`);
    return result;
  };
  const result = await runDaily(referenceDate, {
    collectYouTube: () => collectPlatform("youtube"),
    collectThreads: () => collectPlatform("threads"),
    generateDashboard: () => runDashboard(dashboardStore, dashboardStore, referenceDate),
    generateReport: async (output) => { const report = generateReport(output); await reportStore.writeReport(report); return report; },
    logStore: new GoogleSheetsDailyRunLogStore(auth, config.google.sheetId)
  });
  printDailySummary(result);
  if (result.log.overallStatus === "FAILED") process.exitCode = 1;
  } finally { await lock.release(); }
}

function cliOption(name: string): string {
  const index = process.argv.indexOf(`--${name}`); const value = index >= 0 ? process.argv[index + 1]?.trim() : "";
  if (!value) throw new Error(`Missing required option: --${name}`); return value;
}
async function posting(command: string): Promise<void> {
  const config = loadConfig(), auth = createGoogleAuth(config.google), store = new GoogleSheetsPostStore(auth, config.google.sheetId);
  const needsApi = ["post:threads:dry-run", "post:threads:publish", "post:threads:due"].includes(command);
  let api: ThreadsClient | undefined;
  if (needsApi) { const threads = loadThreadsConfig(); api = new ThreadsClient(await refreshThreadsTokenIfNeeded(threads), threads.baseUrl); }
  const service = new ThreadsPostService(store, api, () => new Date(), store);
  if (command === "post:threads:add") { const post = await service.addDraft(cliOption("text"), process.argv.includes("--notes") ? cliOption("notes") : ""); console.log(`postId=${post.postId} status=${post.status}${post.notes.includes("NEAR_DUPLICATE") ? " nearDuplicate=true" : ""}`); }
  else if (command === "post:threads:import") { const result=await service.importCandidates(await readPostCandidates(cliOption("file")));console.log(`Threads 投稿候補インポート\n\n読込：${result.read}件\nDRAFT：${result.draft}件\nREVIEW：${result.review}件\n重複スキップ：${result.duplicate}件\nエラー：${result.errors}件\n\nGoogle Sheets:\nPostQueue 更新完了`); }
  else if (command === "post:threads:list") { const filter=process.argv.includes("--status")?cliOption("status"):"";let index=0;for (const post of (await service.list()).filter(p=>!filter||p.status===filter)){index++;console.log(`${index}. postId=${post.postId} status=${post.status} scheduledAt=${post.scheduledAt || "-"} preview=${JSON.stringify(post.content.slice(0, 80))} warning=${post.notes.includes("NEAR_DUPLICATE")?"NEAR_DUPLICATE":"-"} notes=${JSON.stringify(post.notes)}`);} }
  else if (command === "post:threads:review") console.log(`status=${(await service.review(cliOption("id"))).status}`);
  else if (command === "post:threads:approve") console.log(`status=${(await service.approve(cliOption("id"))).status}`);
  else if (command === "post:threads:approve-all") {const ids=process.argv.includes("--ids")?cliOption("ids").split(",").map(x=>x.trim()).filter(Boolean):undefined;const approved=await service.approveAll(ids?{ids}:{status:(process.argv.includes("--status")?cliOption("status"):"DRAFT") as import("./posting/types.js").PostStatus});console.log(`approved=${approved.length}`);}
  else if (command === "post:threads:schedule") console.log(`status=${(await service.schedule(cliOption("id"), cliOption("at"))).status}`);
  else if (command === "post:threads:schedule-imported") console.log(`scheduled=${(await service.scheduleImported()).length}`);
  else if (command === "post:threads:schedule-batch") console.log(`scheduled=${(await service.scheduleBatch(cliOption("start"),cliOption("times").split(",").map(x=>x.trim()))).length}`);
  else if (command === "post:threads:cancel") console.log(`status=${(await service.cancel(cliOption("id"))).status}`);
  else if (command === "post:threads:dry-run") { const result = await service.dryRun(cliOption("id")); console.log(JSON.stringify(result, null, 2)); }
  else if (command === "post:threads:publish") { const result = await service.publish(cliOption("id")); console.log(`status=${result.status}`); }
  else if (command === "post:threads:due") { const result = await service.publishDue(process.argv.includes("--dry-run")); console.log(JSON.stringify(result,null,2)); }
  else if (command === "post:threads:status") {const posts=await service.list(),counts=new Map<string,number>();for(const p of posts)counts.set(p.status,(counts.get(p.status)??0)+1);console.log("Threads 投稿キュー\n");for(const status of ["DRAFT","REVIEW","APPROVED","SCHEDULED","PUBLISHED","FAILED","EXPIRED"])console.log(`${status}: ${counts.get(status)??0}`);const next=posts.filter(p=>p.status==="SCHEDULED").sort((a,b)=>a.scheduledAt.localeCompare(b.scheduledAt))[0];console.log(`\n次回投稿:\n${next?.scheduledAt??"なし"}`);}
  else if (command === "post:threads:upcoming") {const limit=process.argv.includes("--limit")?Number(cliOption("limit")):10;for(const p of (await service.list()).filter(p=>p.status==="SCHEDULED").sort((a,b)=>a.scheduledAt.localeCompare(b.scheduledAt)).slice(0,limit))console.log(`${p.scheduledAt} preview=${JSON.stringify(p.content.slice(0,80))} postId=${p.postId}`);}
}

const command = process.argv[2] ?? "collect";
if (command === "collect") await collect(["youtube", "pinterest", "threads"]);
else if (command === "collect:youtube") await collect(["youtube"]);
else if (command === "collect:pinterest") await collect(["pinterest"]);
else if (command === "collect:threads") await collect(["threads"]);
else if (command === "diagnose:youtube") await diagnoseYouTube();
else if (command === "diagnose:threads") await diagnoseThreads();
else if (command === "auth:google") await authorizeGoogle();
else if (command === "auth:threads") await authorizeThreads(loadThreadsOAuthConfig());
else if (command === "import:csv") await importCsv();
else if (command === "import:note") await importCsv("note");
else if (command === "import:rakuten") await importCsv("rakuten");
else if (command === "dashboard") await dashboard();
else if (command === "report") await report();
else if (command === "daily") await daily();
else if (command.startsWith("post:threads:")) await posting(command);
else throw new Error(`Unknown command: ${command}`);
