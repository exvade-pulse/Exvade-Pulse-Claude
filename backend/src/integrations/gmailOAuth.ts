import { config } from "../config.js";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

// Read-only: this integration only ever reads mail to ingest it, never sends,
// deletes, or modifies anything in the connected inbox.
const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

export function buildGmailAuthUrl(state: string): string {
  const url = new URL(AUTH_URL);
  url.searchParams.set("client_id", config.google.clientId);
  url.searchParams.set("redirect_uri", config.google.gmailCallbackUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GMAIL_SCOPE);
  url.searchParams.set("access_type", "offline");
  // Google only returns a refresh_token on an account's very first consent
  // for a given client+scope combination unless prompt=consent forces it --
  // without this, reconnecting (e.g. after a revoke) would silently succeed
  // at the browser step but come back with no refresh_token to store.
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("state", state);
  return url.toString();
}

interface GoogleTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}

export interface GmailTokenExchange {
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
}

export class GmailAuthError extends Error {}

// Exchanges a fresh authorization code (the connect flow, once) for both an
// access token and a refresh token. Throws if Google didn't actually return
// a refresh_token -- silently proceeding without one would leave a
// connection that works today and breaks the next time the access token
// expires, with no way to renew it.
export async function exchangeGmailCode(code: string): Promise<GmailTokenExchange> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: config.google.clientId,
      client_secret: config.google.clientSecret,
      redirect_uri: config.google.gmailCallbackUrl,
      grant_type: "authorization_code",
    }),
  });

  if (!response.ok) {
    throw new GmailAuthError(`Gmail token exchange failed: ${await response.text()}`);
  }

  const tokens = (await response.json()) as GoogleTokenResponse;
  if (!tokens.refresh_token) {
    throw new GmailAuthError(
      "Google did not return a refresh token. This can happen on a re-consent without prompt=consent; try disconnecting and connecting again.",
    );
  }

  return { accessToken: tokens.access_token, refreshToken: tokens.refresh_token, expiresInSeconds: tokens.expires_in };
}

// Exchanges a stored refresh token for a short-lived access token -- called
// before every sync, since access tokens expire in about an hour and syncing
// runs on its own schedule independent of anyone's Pulse session.
export async function refreshGmailAccessToken(refreshToken: string): Promise<string> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: config.google.clientId,
      client_secret: config.google.clientSecret,
      grant_type: "refresh_token",
    }),
  });

  if (!response.ok) {
    throw new GmailAuthError(`Gmail token refresh failed: ${await response.text()}`);
  }

  const tokens = (await response.json()) as GoogleTokenResponse;
  return tokens.access_token;
}

// The connected mailbox's own address, via Gmail's profile endpoint --
// stored on the connection row purely for display ("connected as
// pulse@exvadebio.com" on the Integrations page), not used for any auth
// decision.
export async function fetchGmailProfileEmail(accessToken: string): Promise<string> {
  const response = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    throw new GmailAuthError(`Failed to fetch Gmail profile: ${await response.text()}`);
  }
  const profile = (await response.json()) as { emailAddress: string };
  return profile.emailAddress;
}
