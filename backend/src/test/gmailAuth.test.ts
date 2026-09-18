import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { testDb, truncateAll } from "./helpers.js";
import { createFixtureOrg } from "./fixtures.js";
import { gmailConnections } from "../db/schema.js";
import { buildApp } from "../app.js";
import { signSession, SESSION_COOKIE_NAME } from "../auth/jwt.js";

const { db, client } = testDb();

afterAll(async () => {
  await client.end();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function tokenFor(fixture: Awaited<ReturnType<typeof createFixtureOrg>>) {
  return signSession({
    userId: fixture.user.id,
    organizationId: fixture.org.id,
    email: fixture.user.email,
    role: fixture.authorization.role,
  });
}

function extractCookieValue(setCookieHeader: string | string[] | undefined, name: string): string | undefined {
  const headers = Array.isArray(setCookieHeader) ? setCookieHeader : setCookieHeader ? [setCookieHeader] : [];
  for (const header of headers) {
    const match = header.match(new RegExp(`${name}=([^;]+)`));
    if (match) return match[1];
  }
  return undefined;
}

describe("GET /auth/gmail/connect", () => {
  beforeEach(async () => {
    await truncateAll(db);
  });

  it("requires admin: 401 unauthenticated, 403 for a member", async () => {
    const app = await buildApp();

    const noSession = await app.inject({ method: "GET", url: "/auth/gmail/connect" });
    expect(noSession.statusCode).toBe(401);

    const memberFixture = await createFixtureOrg(db, { domain: "gmail-connect-member.test", role: "member" });
    const asMember = await app.inject({
      method: "GET",
      url: "/auth/gmail/connect",
      cookies: { [SESSION_COOKIE_NAME]: await tokenFor(memberFixture) },
    });
    expect(asMember.statusCode).toBe(403);

    await app.close();
  });

  it("redirects an admin to Google's consent screen and sets a state cookie", async () => {
    const fixture = await createFixtureOrg(db, { domain: "gmail-connect-admin.test" });
    const app = await buildApp();

    const response = await app.inject({
      method: "GET",
      url: "/auth/gmail/connect",
      cookies: { [SESSION_COOKIE_NAME]: await tokenFor(fixture) },
    });

    expect(response.statusCode).toBe(302);
    const location = new URL(response.headers.location as string);
    expect(location.hostname).toBe("accounts.google.com");
    expect(location.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/gmail.readonly");
    expect(extractCookieValue(response.headers["set-cookie"], "pulse_gmail_oauth_state")).toBeDefined();

    await app.close();
  });
});

describe("GET /auth/gmail/callback", () => {
  beforeEach(async () => {
    await truncateAll(db);
  });

  it("requires admin", async () => {
    const app = await buildApp();
    const noSession = await app.inject({ method: "GET", url: "/auth/gmail/callback?code=x&state=y" });
    expect(noSession.statusCode).toBe(401);
    await app.close();
  });

  it("rejects a mismatched or missing state (CSRF protection) and redirects with an error, creating no connection", async () => {
    const fixture = await createFixtureOrg(db, { domain: "gmail-callback-state.test" });
    const app = await buildApp();

    const response = await app.inject({
      method: "GET",
      url: "/auth/gmail/callback?code=some-code&state=wrong-state",
      cookies: { [SESSION_COOKIE_NAME]: await tokenFor(fixture), pulse_gmail_oauth_state: "expected-state" },
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toContain("gmail_error=");

    const rows = await db.select().from(gmailConnections).where(eq(gmailConnections.organizationId, fixture.org.id));
    expect(rows).toHaveLength(0);

    await app.close();
  });

  it("on a valid callback, exchanges the code and stores the connection", async () => {
    const fixture = await createFixtureOrg(db, { domain: "gmail-callback-happy.test" });
    const app = await buildApp();

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("oauth2.googleapis.com/token")) {
          return { ok: true, json: async () => ({ access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600 }) };
        }
        if (url.includes("gmail/v1/users/me/profile")) {
          return { ok: true, json: async () => ({ emailAddress: "pulse@exvadebio.com" }) };
        }
        throw new Error(`Unexpected fetch to ${url}`);
      }),
    );

    const response = await app.inject({
      method: "GET",
      url: "/auth/gmail/callback?code=real-code&state=matching-state",
      cookies: { [SESSION_COOKIE_NAME]: await tokenFor(fixture), pulse_gmail_oauth_state: "matching-state" },
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).not.toContain("gmail_error");

    const [row] = await db.select().from(gmailConnections).where(eq(gmailConnections.organizationId, fixture.org.id));
    expect(row).toBeDefined();
    expect(row.emailAddress).toBe("pulse@exvadebio.com");
    expect(row.refreshToken).toBe("refresh-1");
    expect(row.connectedBy).toBe(fixture.user.id);
    expect(row.lastHistoryId).toBeNull();

    await app.close();
  });

  it("a failed token exchange redirects with an error and stores no connection", async () => {
    const fixture = await createFixtureOrg(db, { domain: "gmail-callback-exchange-fail.test" });
    const app = await buildApp();

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 400, text: async () => "invalid_grant" })),
    );

    const response = await app.inject({
      method: "GET",
      url: "/auth/gmail/callback?code=bad-code&state=matching-state",
      cookies: { [SESSION_COOKIE_NAME]: await tokenFor(fixture), pulse_gmail_oauth_state: "matching-state" },
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toContain("gmail_error=");

    const rows = await db.select().from(gmailConnections).where(eq(gmailConnections.organizationId, fixture.org.id));
    expect(rows).toHaveLength(0);

    await app.close();
  });

  it("reconnecting replaces the credential and resets the sync cursor", async () => {
    const fixture = await createFixtureOrg(db, { domain: "gmail-callback-reconnect.test" });
    await db.insert(gmailConnections).values({
      organizationId: fixture.org.id,
      emailAddress: "old@exvadebio.com",
      refreshToken: "old-refresh",
      lastHistoryId: "12345",
      connectedBy: fixture.user.id,
    });

    const app = await buildApp();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("oauth2.googleapis.com/token")) {
          return { ok: true, json: async () => ({ access_token: "a", refresh_token: "new-refresh", expires_in: 3600 }) };
        }
        return { ok: true, json: async () => ({ emailAddress: "pulse@exvadebio.com" }) };
      }),
    );

    const response = await app.inject({
      method: "GET",
      url: "/auth/gmail/callback?code=x&state=s",
      cookies: { [SESSION_COOKIE_NAME]: await tokenFor(fixture), pulse_gmail_oauth_state: "s" },
    });
    expect(response.statusCode).toBe(302);

    const rows = await db.select().from(gmailConnections).where(eq(gmailConnections.organizationId, fixture.org.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].emailAddress).toBe("pulse@exvadebio.com");
    expect(rows[0].refreshToken).toBe("new-refresh");
    expect(rows[0].lastHistoryId).toBeNull();

    await app.close();
  });
});

describe("DELETE /api/integrations/gmail", () => {
  beforeEach(async () => {
    await truncateAll(db);
  });

  it("requires admin", async () => {
    const app = await buildApp();
    const noSession = await app.inject({ method: "DELETE", url: "/api/integrations/gmail" });
    expect(noSession.statusCode).toBe(401);
    await app.close();
  });

  it("removes the connection, org-scoped", async () => {
    const orgA = await createFixtureOrg(db, { domain: "gmail-disconnect-a.test" });
    const orgB = await createFixtureOrg(db, { domain: "gmail-disconnect-b.test" });
    await db.insert(gmailConnections).values({
      organizationId: orgA.org.id,
      emailAddress: "a@exvadebio.com",
      refreshToken: "refresh-a",
      connectedBy: orgA.user.id,
    });
    await db.insert(gmailConnections).values({
      organizationId: orgB.org.id,
      emailAddress: "b@exvadebio.com",
      refreshToken: "refresh-b",
      connectedBy: orgB.user.id,
    });

    const app = await buildApp();
    const response = await app.inject({
      method: "DELETE",
      url: "/api/integrations/gmail",
      cookies: { [SESSION_COOKIE_NAME]: await tokenFor(orgA) },
    });
    expect(response.statusCode).toBe(200);

    const rowsA = await db.select().from(gmailConnections).where(eq(gmailConnections.organizationId, orgA.org.id));
    expect(rowsA).toHaveLength(0);
    const rowsB = await db.select().from(gmailConnections).where(eq(gmailConnections.organizationId, orgB.org.id));
    expect(rowsB).toHaveLength(1);

    await app.close();
  });
});

describe("GET /api/integrations includes gmail connection status", () => {
  beforeEach(async () => {
    await truncateAll(db);
  });

  it("reports not connected when no row exists, and connected details when one does", async () => {
    const fixture = await createFixtureOrg(db, { domain: "gmail-status.test" });
    const app = await buildApp();

    const before = await app.inject({
      method: "GET",
      url: "/api/integrations",
      cookies: { [SESSION_COOKIE_NAME]: await tokenFor(fixture) },
    });
    const beforeBody = before.json() as { gmail: { connected: boolean } };
    expect(beforeBody.gmail.connected).toBe(false);

    await db.insert(gmailConnections).values({
      organizationId: fixture.org.id,
      emailAddress: "pulse@exvadebio.com",
      refreshToken: "refresh-1",
      connectedBy: fixture.user.id,
    });

    const after = await app.inject({
      method: "GET",
      url: "/api/integrations",
      cookies: { [SESSION_COOKIE_NAME]: await tokenFor(fixture) },
    });
    const afterBody = after.json() as { gmail: { connected: boolean; emailAddress: string | null } };
    expect(afterBody.gmail.connected).toBe(true);
    expect(afterBody.gmail.emailAddress).toBe("pulse@exvadebio.com");

    await app.close();
  });
});
