import "dotenv/config";
import { existsSync, readFileSync } from "node:fs";

export interface Config {
  timeZone: string;
  collectionDate?: string;
  google: {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    refreshToken: string;
    sheetId: string;
    metricsSheet: string;
    contentSheet: string;
    logSheet: string;
  };
}

export interface YouTubeConfig { channelId: string }
export interface PinterestConfig { accessToken: string; username: string; baseUrl: string }
export interface ThreadsConfig {
  appId: string; appSecret: string; redirectUri: string; accessToken: string;
  lookbackDays: number; tokenFile: string; baseUrl: string;
  callbackHost: string; callbackPort: number;
  tokenExpiresAt?: string;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const collectionDate = env.COLLECTION_DATE?.trim();
  return {
    timeZone: required(env, "TZ"),
    ...(collectionDate ? { collectionDate } : {}),
    google: {
      clientId: required(env, "GOOGLE_CLIENT_ID"),
      clientSecret: required(env, "GOOGLE_CLIENT_SECRET"),
      redirectUri: env.GOOGLE_REDIRECT_URI?.trim() || "http://localhost:3000/oauth2callback",
      refreshToken: required(env, "GOOGLE_REFRESH_TOKEN"),
      sheetId: required(env, "METRICS_SPREADSHEET_ID"),
      metricsSheet: env.GOOGLE_METRICS_SHEET?.trim() || "DailyMetrics",
      contentSheet: env.GOOGLE_CONTENT_SHEET?.trim() || "ContentMetrics",
      logSheet: env.GOOGLE_LOG_SHEET?.trim() || "CollectionLog"
    }
  };
}

export function loadYouTubeConfig(env: NodeJS.ProcessEnv = process.env): YouTubeConfig {
  return { channelId: env.YOUTUBE_CHANNEL_ID?.trim() || "mine" };
}

export function loadPinterestConfig(env: NodeJS.ProcessEnv = process.env): PinterestConfig {
  const baseUrl = env.PINTEREST_BASE_URL?.trim() || "https://api.pinterest.com/v5";
  try { new URL(baseUrl); }
  catch { throw new Error("Invalid environment variable: PINTEREST_BASE_URL"); }
  return {
    accessToken: required(env, "PINTEREST_ACCESS_TOKEN"),
    username: required(env, "PINTEREST_USERNAME"),
    baseUrl
  };
}

export function loadThreadsConfig(env: NodeJS.ProcessEnv = process.env): ThreadsConfig {
  const lookbackDays = Number(env.THREADS_LOOKBACK_DAYS?.trim() || "90");
  if (!Number.isInteger(lookbackDays) || lookbackDays < 1) throw new Error("Invalid environment variable: THREADS_LOOKBACK_DAYS");
  const callbackPort = Number(env.THREADS_CALLBACK_PORT?.trim() || "3100");
  if (!Number.isInteger(callbackPort) || callbackPort < 1 || callbackPort > 65535) throw new Error("Invalid environment variable: THREADS_CALLBACK_PORT");
  const tokenFile = env.THREADS_TOKEN_FILE?.trim() || ".threads-token.json";
  let fileToken = "";
  let tokenExpiresAt = "";
  if (existsSync(tokenFile)) {
    try {
      const stored = JSON.parse(readFileSync(tokenFile, "utf8")) as { accessToken?: string; expiresAt?: string };
      fileToken = stored.accessToken?.trim() ?? "";
      tokenExpiresAt = stored.expiresAt?.trim() ?? "";
    }
    catch { throw new Error(`Invalid Threads token file: ${tokenFile}`); }
  }
  const accessToken = fileToken || env.THREADS_ACCESS_TOKEN?.trim();
  if (!accessToken) throw new Error("Missing required environment variable: THREADS_ACCESS_TOKEN (or authorize to create THREADS_TOKEN_FILE)");
  return {
    appId: required(env, "THREADS_APP_ID"),
    appSecret: required(env, "THREADS_APP_SECRET"),
    redirectUri: required(env, "THREADS_REDIRECT_URI"),
    accessToken,
    lookbackDays,
    tokenFile,
    callbackHost: env.THREADS_CALLBACK_HOST?.trim() || "127.0.0.1",
    callbackPort,
    baseUrl: env.THREADS_BASE_URL?.trim() || "https://graph.threads.net",
    ...(tokenExpiresAt ? { tokenExpiresAt } : {})
  };
}

export function loadThreadsOAuthConfig(env: NodeJS.ProcessEnv = process.env): Pick<ThreadsConfig, "appId" | "appSecret" | "redirectUri" | "tokenFile" | "baseUrl" | "callbackHost" | "callbackPort"> {
  const callbackPort = Number(env.THREADS_CALLBACK_PORT?.trim() || "3100");
  if (!Number.isInteger(callbackPort) || callbackPort < 1 || callbackPort > 65535) throw new Error("Invalid environment variable: THREADS_CALLBACK_PORT");
  return {
    appId: required(env, "THREADS_APP_ID"), appSecret: required(env, "THREADS_APP_SECRET"),
    redirectUri: required(env, "THREADS_REDIRECT_URI"), tokenFile: env.THREADS_TOKEN_FILE?.trim() || ".threads-token.json",
    baseUrl: env.THREADS_BASE_URL?.trim() || "https://graph.threads.net",
    callbackHost: env.THREADS_CALLBACK_HOST?.trim() || "127.0.0.1",
    callbackPort
  };
}
