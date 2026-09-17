import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { testDb, truncateAll } from "./helpers.js";
import { createFixtureOrg } from "./fixtures.js";
import { authorizedUsers, organizations, users } from "../db/schema.js";
import { findOrCreateUserForGoogleIdentity, SignInRejectedError } from "../auth/identity.js";
import { buildApp } from "../app.js";
import { signSession, SESSION_COOKIE_NAME } from "../auth/jwt.js";
import { config } from "../config.js";

const { db, client } = testDb();

afterAll(async () => {
  await client.end();
});

describe("bootstrap and allowlist enforcement", () => {
  beforeEach(async () => {
    await truncateAll(db);
  });

  it("the first person to sign in from the home domain bootstraps the org and becomes admin", async () => {
    const identity = { googleId: "g-1", email: `first@${config.allowedDomain}`, name: "First Person" };

    const result = await findOrCreateUserForGoogleIdentity(db, identity);

    expect(result.role).toBe("admin");
    expect(result.org.domain).toBe(config.allowedDomain);
    expect(result.user.email).toBe(identity.email);

    const [authorization] = await db
      .select()
      .from(authorizedUsers)
      .where(and(eq(authorizedUsers.organizationId, result.org.id), eq(authorizedUsers.email, identity.email)));
    expect(authorization).toBeDefined();
    expect(authorization.role).toBe("admin");
    expect(authorization.invitedBy).toBeNull();
  });

  it("a second person on the home domain who is NOT on the allowlist is rejected", async () => {
    await findOrCreateUserForGoogleIdentity(db, {
      googleId: "g-1",
      email: `first@${config.allowedDomain}`,
      name: "First Person",
    });

    const uninvited = { googleId: "g-2", email: `uninvited@${config.allowedDomain}`, name: "Uninvited" };
    await expect(findOrCreateUserForGoogleIdentity(db, uninvited)).rejects.toBeInstanceOf(SignInRejectedError);

    const [row] = await db.select().from(users).where(eq(users.email, uninvited.email));
    expect(row).toBeUndefined();
  });

  it("a person who IS on the allowlist gets a users row created with the correct role on first sign-in", async () => {
    const bootstrap = await findOrCreateUserForGoogleIdentity(db, {
      googleId: "g-1",
      email: `admin@${config.allowedDomain}`,
      name: "Admin",
    });

    await db.insert(authorizedUsers).values({
      organizationId: bootstrap.org.id,
      email: `member@${config.allowedDomain}`,
      role: "member",
      invitedBy: bootstrap.user.id,
    });

    const result = await findOrCreateUserForGoogleIdentity(db, {
      googleId: "g-2",
      email: `member@${config.allowedDomain}`,
      name: "Member Person",
    });

    expect(result.role).toBe("member");
    const [row] = await db.select().from(users).where(eq(users.email, `member@${config.allowedDomain}`));
    expect(row).toBeDefined();
  });

  it("a brand-new, non-home domain can no longer self-bootstrap its own org", async () => {
    const identity = { googleId: "g-1", email: "stranger@some-other-company.test", name: "Stranger" };

    await expect(findOrCreateUserForGoogleIdentity(db, identity)).rejects.toBeInstanceOf(SignInRejectedError);

    const [row] = await db.select().from(users).where(eq(users.email, identity.email));
    expect(row).toBeUndefined();
    const [org] = await db.select().from(organizations).where(eq(organizations.domain, "some-other-company.test"));
    expect(org).toBeUndefined();
  });

  it("an explicitly invited email on a different domain joins the inviting org with its assigned role, bypassing the home-domain gate", async () => {
    const fixture = await createFixtureOrg(db, { domain: "invites-outsiders.test" });
    await db.insert(authorizedUsers).values({
      organizationId: fixture.org.id,
      email: "contractor@gmail.com",
      role: "member",
      invitedBy: fixture.user.id,
    });

    const result = await findOrCreateUserForGoogleIdentity(db, {
      googleId: "g-contractor",
      email: "contractor@gmail.com",
      name: "Contractor",
    });

    expect(result.role).toBe("member");
    expect(result.org.id).toBe(fixture.org.id);
    const [row] = await db.select().from(users).where(eq(users.email, "contractor@gmail.com"));
    expect(row).toBeDefined();
    expect(row.organizationId).toBe(fixture.org.id);
  });
});

describe("requireAuth re-reads authorization on every request", () => {
  beforeEach(async () => {
    await truncateAll(db);
  });

  it("401s once the caller's authorized_users row is deleted, even with a still-valid JWT", async () => {
    const fixture = await createFixtureOrg(db, { domain: "revoke-live.test" });
    const token = await signSession({
      userId: fixture.user.id,
      organizationId: fixture.org.id,
      email: fixture.user.email,
      role: fixture.authorization.role,
    });

    const app = await buildApp();

    const before = await app.inject({
      method: "GET",
      url: "/api/decisions",
      cookies: { [SESSION_COOKIE_NAME]: token },
    });
    expect(before.statusCode).toBe(200);

    await db.delete(authorizedUsers).where(eq(authorizedUsers.id, fixture.authorization.id));

    const after = await app.inject({
      method: "GET",
      url: "/api/decisions",
      cookies: { [SESSION_COOKIE_NAME]: token },
    });
    expect(after.statusCode).toBe(401);

    await app.close();
  });
});

describe("GET/POST/PATCH/DELETE /api/users", () => {
  beforeEach(async () => {
    await truncateAll(db);
  });

  async function tokenFor(fixture: Awaited<ReturnType<typeof createFixtureOrg>>) {
    return signSession({
      userId: fixture.user.id,
      organizationId: fixture.org.id,
      email: fixture.user.email,
      role: fixture.authorization.role,
    });
  }

  it("returns 401 for an unauthenticated request", async () => {
    const app = await buildApp();
    const response = await app.inject({ method: "GET", url: "/api/users" });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("requireAdmin 403s a member-role user and succeeds for an admin", async () => {
    const memberFixture = await createFixtureOrg(db, { domain: "member-gate.test", role: "member" });
    const memberToken = await tokenFor(memberFixture);

    const app = await buildApp();
    const asMember = await app.inject({
      method: "GET",
      url: "/api/users",
      cookies: { [SESSION_COOKIE_NAME]: memberToken },
    });
    expect(asMember.statusCode).toBe(403);

    const adminFixture = await createFixtureOrg(db, { domain: "admin-gate.test" });
    const adminToken = await tokenFor(adminFixture);
    const asAdmin = await app.inject({
      method: "GET",
      url: "/api/users",
      cookies: { [SESSION_COOKIE_NAME]: adminToken },
    });
    expect(asAdmin.statusCode).toBe(200);

    await app.close();
  });

  it("lists authorized users, distinguishing whether they've signed in yet", async () => {
    const fixture = await createFixtureOrg(db, { domain: "list-users.test" });
    await db.insert(authorizedUsers).values({
      organizationId: fixture.org.id,
      email: "not-signed-in@list-users.test",
      role: "member",
      invitedBy: fixture.user.id,
    });

    const app = await buildApp();
    const token = await tokenFor(fixture);
    const response = await app.inject({
      method: "GET",
      url: "/api/users",
      cookies: { [SESSION_COOKIE_NAME]: token },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      users: Array<{ email: string; hasSignedIn: boolean; name: string | null }>;
    };

    const admin = body.users.find((u) => u.email === fixture.user.email);
    expect(admin?.hasSignedIn).toBe(true);
    expect(admin?.name).toBe(fixture.user.name);

    const pending = body.users.find((u) => u.email === "not-signed-in@list-users.test");
    expect(pending?.hasSignedIn).toBe(false);
    expect(pending?.name).toBeNull();

    await app.close();
  });

  it("POST /api/users can authorize an email outside the org's own domain (a contractor, an advisor)", async () => {
    const fixture = await createFixtureOrg(db, { domain: "domain-check.test" });
    const app = await buildApp();
    const token = await tokenFor(fixture);

    const response = await app.inject({
      method: "POST",
      url: "/api/users",
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { email: "outsider@some-other-company.test", role: "member" },
    });
    expect(response.statusCode).toBe(201);

    const [row] = await db
      .select()
      .from(authorizedUsers)
      .where(eq(authorizedUsers.email, "outsider@some-other-company.test"));
    expect(row).toBeDefined();
    expect(row.organizationId).toBe(fixture.org.id);

    await app.close();
  });

  it("POST /api/users rejects a malformed email", async () => {
    const fixture = await createFixtureOrg(db, { domain: "bad-email.test" });
    const app = await buildApp();
    const token = await tokenFor(fixture);

    const response = await app.inject({
      method: "POST",
      url: "/api/users",
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { email: "not-an-email", role: "member" },
    });
    expect(response.statusCode).toBe(400);

    const [row] = await db.select().from(authorizedUsers).where(eq(authorizedUsers.email, "not-an-email"));
    expect(row).toBeUndefined();

    await app.close();
  });

  it("PATCH /api/users/:email/role and DELETE /api/users/:email both reject self-targeting", async () => {
    const fixture = await createFixtureOrg(db, { domain: "self-target.test" });
    const app = await buildApp();
    const token = await tokenFor(fixture);

    const patchSelf = await app.inject({
      method: "PATCH",
      url: `/api/users/${fixture.user.email}/role`,
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { role: "member" },
    });
    expect(patchSelf.statusCode).toBe(409);

    const deleteSelf = await app.inject({
      method: "DELETE",
      url: `/api/users/${fixture.user.email}`,
      cookies: { [SESSION_COOKIE_NAME]: token },
    });
    expect(deleteSelf.statusCode).toBe(409);

    const [row] = await db.select().from(authorizedUsers).where(eq(authorizedUsers.email, fixture.user.email));
    expect(row).toBeDefined();
    expect(row.role).toBe("admin");

    await app.close();
  });

  it("an admin can authorize, re-role, and revoke someone else", async () => {
    const fixture = await createFixtureOrg(db, { domain: "full-cycle.test" });
    const app = await buildApp();
    const token = await tokenFor(fixture);
    const targetEmail = "newperson@full-cycle.test";

    const created = await app.inject({
      method: "POST",
      url: "/api/users",
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { email: targetEmail, role: "member" },
    });
    expect(created.statusCode).toBe(201);

    const promoted = await app.inject({
      method: "PATCH",
      url: `/api/users/${targetEmail}/role`,
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { role: "admin" },
    });
    expect(promoted.statusCode).toBe(200);
    const [afterPromote] = await db.select().from(authorizedUsers).where(eq(authorizedUsers.email, targetEmail));
    expect(afterPromote.role).toBe("admin");

    const revoked = await app.inject({
      method: "DELETE",
      url: `/api/users/${targetEmail}`,
      cookies: { [SESSION_COOKIE_NAME]: token },
    });
    expect(revoked.statusCode).toBe(200);
    const [afterRevoke] = await db.select().from(authorizedUsers).where(eq(authorizedUsers.email, targetEmail));
    expect(afterRevoke).toBeUndefined();

    await app.close();
  });

  it("an admin from org A cannot list, authorize, or revoke users in org B", async () => {
    const orgA = await createFixtureOrg(db, { domain: "iso-users-a.test" });
    const orgB = await createFixtureOrg(db, { domain: "iso-users-b.test" });

    const app = await buildApp();
    const tokenA = await tokenFor(orgA);

    const list = await app.inject({
      method: "GET",
      url: "/api/users",
      cookies: { [SESSION_COOKIE_NAME]: tokenA },
    });
    expect(list.statusCode).toBe(200);
    const body = list.json() as { users: Array<{ email: string }> };
    expect(body.users.map((u) => u.email)).not.toContain(orgB.user.email);

    // Domain no longer implies org membership, so orgA's admin authorizing an
    // email that happens to share orgB's domain succeeds -- but it must land
    // in orgA, never orgB, which is the actual isolation guarantee here.
    const crossOrgAuthorize = await app.inject({
      method: "POST",
      url: "/api/users",
      cookies: { [SESSION_COOKIE_NAME]: tokenA },
      payload: { email: "someone@iso-users-b.test", role: "member" },
    });
    expect(crossOrgAuthorize.statusCode).toBe(201);
    const [crossOrgRow] = await db
      .select()
      .from(authorizedUsers)
      .where(eq(authorizedUsers.email, "someone@iso-users-b.test"));
    expect(crossOrgRow.organizationId).toBe(orgA.org.id);

    const crossOrgRevoke = await app.inject({
      method: "DELETE",
      url: `/api/users/${orgB.user.email}`,
      cookies: { [SESSION_COOKIE_NAME]: tokenA },
    });
    expect(crossOrgRevoke.statusCode).toBe(404);

    const [stillThere] = await db.select().from(authorizedUsers).where(eq(authorizedUsers.email, orgB.user.email));
    expect(stillThere).toBeDefined();

    await app.close();
  });
});
