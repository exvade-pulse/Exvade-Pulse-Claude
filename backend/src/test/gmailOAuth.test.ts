import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildGmailAuthUrl,
  exchangeGmailCode,
  fetchGmailProfileEmail,
  GmailAuthError,
  refreshGmailAccessToken,
} from "../integrations/gmailOAuth.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("buildGmailAuthUrl", () => {
  it("requests the read-only Gmail scope, offline access, and forced consent", () => {
    const url = new URL(buildGmailAuthUrl("state-123"));
    expect(url.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/gmail.readonly");
    expect(url.searchParams.get("access_type")).toBe("offline");
    // prompt=consent, not the default -- without it Google only issues a
    // refresh_token on an account's very first-ever consent, which would
    // silently break reconnecting after a disconnect.
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("state")).toBe("state-123");
    expect(url.searchParams.get("response_type")).toBe("code");
  });
});

describe("exchangeGmailCode", () => {
  it("returns the access and refresh tokens on success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600 }),
      })),
    );

    const result = await exchangeGmailCode("auth-code");
    expect(result).toEqual({ accessToken: "access-1", refreshToken: "refresh-1", expiresInSeconds: 3600 });
  });

  it("throws GmailAuthError when Google doesn't return a refresh_token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ access_token: "access-1", expires_in: 3600 }),
      })),
    );

    await expect(exchangeGmailCode("auth-code")).rejects.toBeInstanceOf(GmailAuthError);
  });

  it("throws GmailAuthError when the token endpoint responds with an error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 400, text: async () => "invalid_grant" })),
    );

    await expect(exchangeGmailCode("bad-code")).rejects.toBeInstanceOf(GmailAuthError);
  });
});

describe("refreshGmailAccessToken", () => {
  it("returns a fresh access token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ access_token: "fresh-access", expires_in: 3600 }) })),
    );

    expect(await refreshGmailAccessToken("stored-refresh-token")).toBe("fresh-access");
  });

  it("throws GmailAuthError on failure (e.g. a revoked refresh token)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 400, text: async () => "invalid_grant" })),
    );

    await expect(refreshGmailAccessToken("revoked-token")).rejects.toBeInstanceOf(GmailAuthError);
  });
});

describe("fetchGmailProfileEmail", () => {
  it("returns the connected mailbox's address", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ emailAddress: "pulse@exvadebio.com" }) })),
    );

    expect(await fetchGmailProfileEmail("access-token")).toBe("pulse@exvadebio.com");
  });

  it("throws GmailAuthError on failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 401, text: async () => "unauthorized" })),
    );

    await expect(fetchGmailProfileEmail("bad-token")).rejects.toBeInstanceOf(GmailAuthError);
  });
});
