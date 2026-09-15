import { eq } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { organizations, users } from "../db/schema.js";
import { emailDomain } from "./google.js";

export interface GoogleIdentity {
  googleId: string;
  email: string;
  name: string;
}

// Finds or creates the organization for this email's domain, then finds or
// creates the user within it. Called only after the domain has already been
// verified against config.allowedDomain by the caller.
export async function findOrCreateUserForGoogleIdentity(db: Database, identity: GoogleIdentity) {
  const domain = emailDomain(identity.email);

  return db.transaction(async (tx) => {
    let [org] = await tx.select().from(organizations).where(eq(organizations.domain, domain));
    if (!org) {
      [org] = await tx
        .insert(organizations)
        .values({ name: domain, domain })
        .returning();
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

    return { org, user };
  });
}
