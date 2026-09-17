import { asc, eq } from "drizzle-orm";
import type { Database, Transaction } from "../db/client.js";
import { authorizedUsers, organizations, users } from "../db/schema.js";
import { config } from "../config.js";
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

async function findOrCreateUserRow(
  tx: Transaction,
  params: { organizationId: string; googleId: string; email: string; name: string },
) {
  let [user] = await tx.select().from(users).where(eq(users.googleId, params.googleId));
  if (!user) {
    [user] = await tx
      .insert(users)
      .values({
        organizationId: params.organizationId,
        googleId: params.googleId,
        email: params.email,
        name: params.name,
      })
      .returning();
  }
  return user;
}

// A verified Google identity is let in one of two ways:
//
// 1. An explicit invite (an authorized_users row for this exact email, in
//    ANY organization) always wins, regardless of what domain the email is
//    on -- this is what lets an admin bring in a contractor/advisor on a
//    gmail.com address without that domain getting its own organization.
//    (An email can only ever be invited into more than one org in a
//    freak-accident edge case this app doesn't otherwise support -- users.email
//    is globally unique once someone's actually signed in -- so the oldest
//    invite deterministically wins rather than leaving it to query order.)
// 2. Failing that, only the configured home domain (config.allowedDomain) may
//    still self-bootstrap a brand-new organization, and only its very first
//    signer ever, who becomes that org's admin. Anyone else -- any other
//    domain, or a second-plus person on the home domain with no invite -- is
//    rejected. This is the actual enforcement point for "invite only": it's
//    not a domain allowlist anymore, it's "invited, or the very first person
//    from the home domain."
export async function findOrCreateUserForGoogleIdentity(db: Database, identity: GoogleIdentity) {
  return db.transaction(async (tx) => {
    const [authorization] = await tx
      .select()
      .from(authorizedUsers)
      .where(eq(authorizedUsers.email, identity.email))
      .orderBy(asc(authorizedUsers.createdAt))
      .limit(1);

    if (authorization) {
      const [org] = await tx.select().from(organizations).where(eq(organizations.id, authorization.organizationId));
      const user = await findOrCreateUserRow(tx, { organizationId: org.id, ...identity });
      return { org, user, role: authorization.role };
    }

    const domain = emailDomain(identity.email);
    if (domain === config.allowedDomain) {
      const [existingHomeOrg] = await tx.select().from(organizations).where(eq(organizations.domain, domain));

      if (!existingHomeOrg) {
        const [org] = await tx.insert(organizations).values({ name: domain, domain }).returning();
        await tx.insert(authorizedUsers).values({
          organizationId: org.id,
          email: identity.email,
          role: "admin",
          invitedBy: null,
        });
        const user = await findOrCreateUserRow(tx, { organizationId: org.id, ...identity });
        return { org, user, role: "admin" as const };
      }
    }

    throw new SignInRejectedError(identity.email);
  });
}
