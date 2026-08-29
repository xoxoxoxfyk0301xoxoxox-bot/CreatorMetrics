import { createServer } from "node:http";
import { writeFile } from "node:fs/promises";
import { URL } from "node:url";

export const THREADS_SCOPES = ["threads_basic", "threads_manage_insights", "threads_content_publish"] as const;
export interface ThreadsToken { accessToken: string; expiresAt: string }
export interface ThreadsOAuthConfig {
  appId: string; appSecret: string; redirectUri: string; tokenFile: string; baseUrl: string;
  callbackHost: string; callbackPort: number;
}

export function validateThreadsOAuthConfig(config: ThreadsOAuthConfig): URL {
  const redirect = new URL(config.redirectUri);
  if (redirect.protocol !== "https:") throw new Error("THREADS_REDIRECT_URI must use HTTPS");
  if (!redirect.pathname || redirect.pathname === "/") throw new Error("THREADS_REDIRECT_URI must include a callback path such as /oauth2callback");
  if (redirect.hash) throw new Error("THREADS_REDIRECT_URI must not include a URL fragment");
  if (config.callbackHost !== "127.0.0.1" && config.callbackHost !== "localhost") throw new Error("THREADS_CALLBACK_HOST must be 127.0.0.1 or localhost");
  if (!Number.isInteger(config.callbackPort) || config.callbackPort < 1 || config.callbackPort > 65535) throw new Error("THREADS_CALLBACK_PORT must be an integer from 1 to 65535");
  return redirect;
}

export function buildThreadsAuthorizationUrl(config: ThreadsOAuthConfig): URL {
  validateThreadsOAuthConfig(config);
  const authorization = new URL("https://threads.net/oauth/authorize");
  authorization.search = new URLSearchParams({ client_id: config.appId, redirect_uri: config.redirectUri, scope: THREADS_SCOPES.join(","), response_type: "code" }).toString();
  return authorization;
}

export function getThreadsCallbackListenAddress(config: ThreadsOAuthConfig): { host: string; port: number } {
  validateThreadsOAuthConfig(config);
  return { host: config.callbackHost, port: config.callbackPort };
}

async function tokenRequest(url: URL, method = "GET"): Promise<ThreadsToken> {
  const response = await fetch(url, { method, headers: { Accept: "application/json" } });
  const body = await response.json().catch(() => ({})) as { access_token?: string; expires_in?: number; error?: { message?: string; code?: number } };
  if (!response.ok || body.error || !body.access_token) throw new Error(`[THREADS_AUTH_${body.error?.code ?? response.status}] ${body.error?.message ?? "Token request failed"}`);
  return { accessToken: body.access_token, expiresAt: new Date(Date.now() + (body.expires_in ?? 5184000) * 1000).toISOString() };
}

export async function exchangeThreadsCode(config: ThreadsOAuthConfig, code: string): Promise<ThreadsToken> {
  const shortUrl = new URL(`${config.baseUrl}/oauth/access_token`);
  shortUrl.search = new URLSearchParams({ client_id: config.appId, client_secret: config.appSecret, code, grant_type: "authorization_code", redirect_uri: config.redirectUri }).toString();
  const shortToken = await tokenRequest(shortUrl, "POST");
  const longUrl = new URL(`${config.baseUrl}/access_token`);
  longUrl.search = new URLSearchParams({ grant_type: "th_exchange_token", client_secret: config.appSecret, access_token: shortToken.accessToken }).toString();
  return tokenRequest(longUrl);
}

export async function refreshThreadsToken(config: Pick<ThreadsOAuthConfig, "baseUrl">, accessToken: string): Promise<ThreadsToken> {
  const url = new URL(`${config.baseUrl}/refresh_access_token`);
  url.search = new URLSearchParams({ grant_type: "th_refresh_token", access_token: accessToken }).toString();
  return tokenRequest(url);
}

export async function saveThreadsToken(path: string, token: ThreadsToken): Promise<void> {
  await writeFile(path, `${JSON.stringify(token)}\n`, { encoding: "utf8", mode: 0o600, flag: "w" });
}

export async function refreshThreadsTokenIfNeeded(config: ThreadsOAuthConfig & { accessToken: string; tokenExpiresAt?: string }): Promise<string> {
  if (!config.tokenExpiresAt) return config.accessToken;
  const refreshThreshold = Date.now() + 7 * 86400000;
  if (Date.parse(config.tokenExpiresAt) > refreshThreshold) return config.accessToken;
  const token = await refreshThreadsToken(config, config.accessToken);
  await saveThreadsToken(config.tokenFile, token);
  return token.accessToken;
}

export async function authorizeThreads(config: ThreadsOAuthConfig): Promise<void> {
  const redirect = validateThreadsOAuthConfig(config);
  const authorization = buildThreadsAuthorizationUrl(config);
  const listen = getThreadsCallbackListenAddress(config);
  console.log(`Open this Threads authorization URL in a browser:\n${authorization}`);
  await new Promise<void>((resolve, reject) => {
    const server = createServer(async (request, response) => {
      try {
        const requestUrl = new URL(request.url ?? "/", `http://${listen.host}:${listen.port}`);
        if (requestUrl.pathname !== redirect.pathname) { response.statusCode = 404; response.end("Not found."); return; }
        const code = requestUrl.searchParams.get("code");
        if (!code) throw new Error(requestUrl.searchParams.get("error") ?? "Missing Threads authorization code");
        const token = await exchangeThreadsCode(config, code);
        await saveThreadsToken(config.tokenFile, token);
        response.end("Threads authorization complete. You can close this window.");
        server.close();
        console.log(`Threads long-lived token was saved to ${config.tokenFile} with owner-only permissions. The token value was not printed.`);
        resolve();
      } catch (error) { response.statusCode = 500; response.end("Threads authorization failed."); server.close(); reject(error); }
    });
    server.listen(listen.port, listen.host);
  });
}
