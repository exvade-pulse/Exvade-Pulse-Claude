import { and, eq } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { auditLog, authorizedUsers, users, type UserRole } from "../db/schema.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class UserManageError extends Error {
  code: "invalid_email" | "self_target" | "not_found";

  constructor(message: string, code: "invalid_email" | "self_target" | "not_found") {
    super(message);
    this.code = code;
  }
}

export async function listAuthorizedUsers(db: Database, organizationId: string) {
  return db
    .select({
      email: authorizedUsers.email,
      role: authorizedUsers.role,
      createdAt: authorizedUsers.createdAt,
      name: users.name,
      hasSignedIn: users.id,
    })
    .from(authorizedUsers)
    .leftJoin(users, and(eq(users.organizationId, authorizedUsers.organizationId), eq(users.email, authorizedUsers.email)))
    .where(eq(authorizedUsers.organizationId, organizationId))
    .then((rows) =>
      rows.map((row) => ({
        email: row.email,
        role: row.role,
        createdAt: row.createdAt,
        name: row.name,
        hasSignedIn: row.hasSignedIn !== null,
      })),
    );
}

interface AuthorizeParams {
  organizationId: string;
  actorId: string;
  email: string;
  role: UserRole;
}

// Deliberately not restricted to the org's own email domain: an admin can
// invite anyone -- a contractor, an advisor, someone on a different company's
// domain entirely -- since auth/identity.ts's sign-in gate now honors an
// explicit authorized_users row regardless of domain. The only requirement
// left is that it looks like an email address at all.
export async function authorizeUser(db: Database, params: AuthorizeParams) {
  if (!EMAIL_RE.test(params.email)) {
    throw new UserManageError("That doesn't look like a valid email address", "invalid_email");
  }

  return db.transaction(async (tx) => {
    const [record] = await tx
      .insert(authorizedUsers)
      .values({
        organizationId: params.organizationId,
        email: params.email,
        role: params.role,
        invitedBy: params.actorId,
      })
      .onConflictDoUpdate({
        target: [authorizedUsers.organizationId, authorizedUsers.email],
        set: { role: params.role },
      })
      .returning();

    await tx.insert(auditLog).values({
      organizationId: params.organizationId,
      actorId: params.actorId,
      action: "user.authorized",
      entityType: "authorized_user",
      entityId: record.id,
      details: { email: params.email, role: params.role },
    });

    return record;
  });
}

interface ChangeRoleParams {
  organizationId: string;
  actorId: string;
  actorEmail: string;
  email: string;
  role: UserRole;
}

export async function changeUserRole(db: Database, params: ChangeRoleParams) {
  if (params.email === params.actorEmail) {
    throw new UserManageError("You cannot change your own role", "self_target");
  }

  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(authorizedUsers)
      .where(and(eq(authorizedUsers.organizationId, params.organizationId), eq(authorizedUsers.email, params.email)));

    if (!existing) {
      throw new UserManageError("User is not authorized for this organization", "not_found");
    }

    const [updated] = await tx
      .update(authorizedUsers)
      .set({ role: params.role })
      .where(eq(authorizedUsers.id, existing.id))
      .returning();

    await tx.insert(auditLog).values({
      organizationId: params.organizationId,
      actorId: params.actorId,
      action: "user.role_changed",
      entityType: "authorized_user",
      entityId: updated.id,
      details: { email: params.email, role: params.role },
    });

    return updated;
  });
}

interface RevokeParams {
  organizationId: string;
  actorId: string;
  actorEmail: string;
  email: string;
}

export async function revokeUser(db: Database, params: RevokeParams) {
  if (params.email === params.actorEmail) {
    throw new UserManageError("You cannot revoke your own access", "self_target");
  }

  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(authorizedUsers)
      .where(and(eq(authorizedUsers.organizationId, params.organizationId), eq(authorizedUsers.email, params.email)));

    if (!existing) {
      throw new UserManageError("User is not authorized for this organization", "not_found");
    }

    await tx.delete(authorizedUsers).where(eq(authorizedUsers.id, existing.id));

    await tx.insert(auditLog).values({
      organizationId: params.organizationId,
      actorId: params.actorId,
      action: "user.revoked",
      entityType: "authorized_user",
      entityId: existing.id,
      details: { email: params.email },
    });
  });
}
