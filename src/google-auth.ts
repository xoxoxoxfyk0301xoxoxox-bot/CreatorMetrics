import { google } from "googleapis";

export function createGoogleAuth(config: {
  clientId: string; clientSecret: string; redirectUri: string; refreshToken: string;
}) {
  const auth = new google.auth.OAuth2(config.clientId, config.clientSecret, config.redirectUri);
  auth.setCredentials({ refresh_token: config.refreshToken });
  return auth;
}

export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/yt-analytics.readonly",
  "https://www.googleapis.com/auth/youtube.readonly",
  "https://www.googleapis.com/auth/spreadsheets"
];
