import { and, eq } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { authorizedUsers, organizations, users } from "../db/schema.js";
import { emailDomain } from "./google.js";

export interface GoogleIdentity {
  googleId: string;
  email: string;
  name: string;
}

export class SignInRejectedError extends Error {
  constructor(email: string) {
    super(`Your account isn't approved yet. Ask an admin to add ${email} in Exvade Pulse.`);
  }
}

// Given a verified Google identity whose domain already passed the
// config.allowedDomain check in routes/auth.ts, either bootstraps a brand new
// organization (first person ever from this domain becomes its admin) or
// enforces the authorized_users allowlist for an existing one.
export async function findOrCreateUserForGoogleIdentity(db: Database, identity: GoogleIdentity) {
  const domain = emailDomain(identity.email);

  return db.transaction(async (tx) => {
    let [org] = await tx.select().from(organizations).where(eq(organizations.domain, domain));

    if (!org) {
      [org] = await tx.insert(organizations).values({ name: domain, domain }).returning();

      await tx.insert(authorizedUsers).values({
        organizationId: org.id,
        email: identity.email,
        role: "admin",
        invitedBy: null,
      });

      const [user] = await tx
        .insert(users)
        .values({
          organizationId: org.id,
          googleId: identity.googleId,
          email: identity.email,
          name: identity.name,
        })
        .returning();

      return { org, user, role: "admin" as const };
    }

    const [authorization] = await tx
      .select()
      .from(authorizedUsers)
      .where(and(eq(authorizedUsers.organizationId, org.id), eq(authorizedUsers.email, identity.email)));

    if (!authorization) {
      throw new SignInRejectedError(identity.email);
    }

    let [user] = await tx.select().from(users).where(eq(users.googleId, identity.googleId));
    if (!user) {
      [user] = await tx
        .insert(users)
        .values({
          organizationId: org.id,
          googleId: identity.googleId,
          email: identity.email,
          name: identity.name,
        })
        .returning();
    }

    return { org, user, role: authorization.role };
  });
}
