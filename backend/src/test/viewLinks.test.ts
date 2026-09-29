import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { testDb, truncateAll } from "./helpers.js";
import { createFixtureOrg } from "./fixtures.js";
import { authorizedUsers, decisions, viewLinks } from "../db/schema.js";
import { buildApp } from "../app.js";
import { signSession, SESSION_COOKIE_NAME } from "../auth/jwt.js";

const { db, client } = testDb();

afterAll(async () => {
  await client.end();
});

type Fixture = Awaited<ReturnType<typeof createFixtureOrg>>;
type App = Awaited<ReturnType<typeof buildApp>>;

async function adminCookie(fixture: Fixture, role: "admin" | "member" = "admin") {
  await db.update(authorizedUsers).set({ role }).where(eq(authorizedUsers.id, fixture.authorization.id));
  return { [SESSION_COOKIE_NAME]: await signSession({ userId: fixture.user.id, organizationId: fixture.org.id, email: fixture.user.email, role }) };
}

async function createLink(app: App, fixture: Fixture, includeRestricted = false) {
  const res = await app.inject({
    method: "POST",
    url: "/api/view-links",
    cookies: await adminCookie(fixture),
    payload: { label: "ChatGPT agent", days: 7, includeRestricted },
  });
  expect(res.statusCode).toBe(201);
  const body = res.json() as { id: string; url: string; password: string };
  return { ...body, token: new URL(body.url).searchParams.get("t")! };
}

async function unlock(app: App, token: string, password: string) {
  const res = await app.inject({ method: "POST", url: "/api/view/unlock", payload: { token, password } });
  const cookie = res.cookies.find((c) => c.name === SESSION_COOKIE_NAME);
  return { res, cookies: cookie ? { [SESSION_COOKIE_NAME]: cookie.value } : undefined };
}

describe("view-only links", () => {
  beforeEach(async () => {
    await truncateAll(db);
  });

  it("with the right password gives a read-only session that can browse but never change anything", async () => {
    const fixture = await createFixtureOrg(db, { domain: "view-flow.test" });
    await db.insert(decisions).values([
      { organizationId: fixture.org.id, title: "Team decision", decider: "Sean" },
      { organizationId: fixture.org.id, title: "Board-only decision", decider: "Sean", visibility: "leadership" },
    ]);
    const app = await buildApp();
    const link = await createLink(app, fixture);
    expect(link.password).toMatch(/^[a-z2-9]{5}(-[a-z2-9]{5}){3}$/);
    const stored = await db.select().from(viewLinks);
    expect(JSON.stringify(stored)).not.toContain(link.password);
    expect(JSON.stringify(stored)).not.toContain(link.token);

    const { res, cookies } = await unlock(app, link.token, link.password);
    expect(res.statusCode).toBe(200);

    const me = await app.inject({ method: "GET", url: "/auth/me", cookies });
    expect(me.json().user).toMatchObject({ readOnly: true, role: "member", email: "view-only" });

    const review = await app.inject({ method: "GET", url: "/api/reports/executive-review", cookies });
    expect(review.statusCode).toBe(200);
    const decisionsList = await app.inject({ method: "GET", url: "/api/decisions", cookies });
    expect(decisionsList.body).toContain("Team decision");
    expect(decisionsList.body).not.toContain("Board-only decision");

    for (const [method, url] of [
      ["POST", "/api/questions"],
      ["POST", "/api/reports/executive-review/mark-reviewed"],
      ["POST", "/api/reviews/cleanup"],
      ["PUT", "/api/company-context"],
      ["POST", "/api/suggestions/00000000-0000-4000-8000-000000000000/approve"],
      ["GET", "/api/users"],
      ["GET", "/api/integrations"],
      ["GET", "/api/view-links"],
    ] as const) {
      const r = await app.inject({ method, url, cookies, payload: method === "GET" ? undefined : {} });
      expect(r.statusCode, `${method} ${url}`).toBe(403);
    }
    await app.close();
  });

  it("can include Leadership/Restricted items when created that way, still read-only", async () => {
    const fixture = await createFixtureOrg(db, { domain: "view-restricted.test" });
    await db.insert(decisions).values({ organizationId: fixture.org.id, title: "Board-only decision", decider: "Sean", visibility: "leadership" });
    const app = await buildApp();
    const link = await createLink(app, fixture, true);
    const { cookies } = await unlock(app, link.token, link.password);
    const list = await app.inject({ method: "GET", url: "/api/decisions", cookies });
    expect(list.body).toContain("Board-only decision");
    expect((await app.inject({ method: "GET", url: "/api/users", cookies })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/api/view-links", cookies, payload: { days: 7, includeRestricted: true } })).statusCode).toBe(403);
    await app.close();
  });

  it("locks after 5 wrong passwords, switches itself off after 20, and rejects unknown links the same way", async () => {
    const fixture = await createFixtureOrg(db, { domain: "view-lock.test" });
    const app = await buildApp();
    const link = await createLink(app, fixture);

    for (let i = 0; i < 5; i++) expect((await unlock(app, link.token, "wrong")).res.statusCode).toBe(401);
    const locked = await unlock(app, link.token, link.password);
    expect(locked.res.statusCode).toBe(429);
    expect(locked.cookies).toBeUndefined();

    await db.update(viewLinks).set({ failedAttempts: 19, lockedUntil: null });
    expect((await unlock(app, link.token, "wrong")).res.statusCode).toBe(401);
    const [row] = await db.select().from(viewLinks);
    expect(row.revokedAt).not.toBeNull();
    expect((await unlock(app, link.token, link.password)).res.statusCode).toBe(401);

    expect((await unlock(app, "not-a-real-token-at-all", "whatever")).res.json()).toEqual({
      error: "This link is invalid, has expired, or has been switched off.",
    });
    await app.close();
  });

  it("switching a link off or letting it expire ends sessions already open with it", async () => {
    const fixture = await createFixtureOrg(db, { domain: "view-revoke.test" });
    const app = await buildApp();
    const link = await createLink(app, fixture);
    const { cookies } = await unlock(app, link.token, link.password);
    expect((await app.inject({ method: "GET", url: "/auth/me", cookies })).statusCode).toBe(200);

    const listed = await app.inject({ method: "GET", url: "/api/view-links", cookies: await adminCookie(fixture) });
    expect(listed.json().links).toMatchObject([{ id: link.id, label: "ChatGPT agent", active: true }]);

    const revoke = await app.inject({ method: "POST", url: `/api/view-links/${link.id}/revoke`, cookies: await adminCookie(fixture) });
    expect(revoke.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/auth/me", cookies })).statusCode).toBe(401);

    const second = await createLink(app, fixture);
    const opened = await unlock(app, second.token, second.password);
    await db.update(viewLinks).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(viewLinks.id, second.id));
    expect((await app.inject({ method: "GET", url: "/auth/me", cookies: opened.cookies })).statusCode).toBe(401);
    await app.close();
  });

  it("only admins create or manage links", async () => {
    const fixture = await createFixtureOrg(db, { domain: "view-member.test" });
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/view-links",
      cookies: await adminCookie(fixture, "member"),
      payload: { days: 7, includeRestricted: false },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});
