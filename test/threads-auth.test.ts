import { describe, expect, it, vi } from "vitest";
import { buildThreadsAuthorizationUrl, getThreadsCallbackListenAddress, validateThreadsOAuthConfig, type ThreadsOAuthConfig } from "../src/threads-auth.js";

const config: ThreadsOAuthConfig = {
  appId: "threads-app-id",
  appSecret: "threads-app-secret-must-not-be-logged",
  redirectUri: "https://farming-voting-begin-snow.trycloudflare.com/oauth2callback",
  callbackHost: "127.0.0.1",
  callbackPort: 3100,
  tokenFile: ".threads-token.json",
  baseUrl: "https://graph.threads.net"
};

describe("Threads OAuth callback routing", () => {
  it("starts authorization with an HTTPS public redirect URI", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const authorization = buildThreadsAuthorizationUrl(config);
    expect(authorization.searchParams.get("redirect_uri")).toBe(config.redirectUri);
    expect(authorization.searchParams.get("scope")).toBe("threads_basic,threads_manage_insights,threads_content_publish");
    expect(authorization.toString()).not.toContain(config.appSecret);
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it("listens locally on 127.0.0.1:3100 independently of the public redirect", () => {
    expect(getThreadsCallbackListenAddress(config)).toEqual({ host: "127.0.0.1", port: 3100 });
  });

  it("rejects non-HTTPS redirects and redirects without a callback path", () => {
    expect(() => validateThreadsOAuthConfig({ ...config, redirectUri: "http://example.com/oauth2callback" })).toThrow("must use HTTPS");
    expect(() => validateThreadsOAuthConfig({ ...config, redirectUri: "https://example.com/" })).toThrow("callback path");
  });
});
