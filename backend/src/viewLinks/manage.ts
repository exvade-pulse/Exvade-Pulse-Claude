import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import type { DbOrTx } from "../db/client.js";
import { auditLog, users, viewLinks } from "../db/schema.js";

export const VIEW_LINK_DAYS = [1, 7, 30] as const;
const MAX_FAILURES_BEFORE_LOCK = 5;
const LOCK_MINUTES = 15;
// Past this many wrong passwords the link switches itself off for good.
const MAX_FAILURES_BEFORE_REVOKE = 20;

export class ViewLinkError extends Error {
  constructor(
    message: string,
    public code: "invalid" | "locked",
  ) {
    super(message);
  }
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

function hashPassword(password: string): string {
  const salt = randomBytes(16);
  return `${salt.toString("hex")}:${scryptSync(password, salt, 32).toString("hex")}`;
}

function passwordMatches(password: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = scryptSync(password, Buffer.from(saltHex, "hex"), expected.length);
  return timingSafeEqual(actual, expected);
}

// Easy to type or paste, still ~95 bits: four groups of five characters.
function generatePassword(): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const bytes = randomBytes(20);
  const chars = [...bytes].map((b) => alphabet[b % alphabet.length]);
  return [0, 5, 10, 15].map((i) => chars.slice(i, i + 5).join("")).join("-");
}

export async function createViewLink(
  db: DbOrTx,
  params: { organizationId: string; actorId: string; label: string | null; days: number; includeRestricted: boolean },
) {
  const token = randomBytes(32).toString("base64url");
  const password = generatePassword();
  const expiresAt = new Date(Date.now() + params.days * 24 * 60 * 60 * 1000);
  const [link] = await db
    .insert(viewLinks)
    .values({
      organizationId: params.organizationId,
      label: params.label?.trim() || null,
      tokenHash: sha256(token),
      passwordHash: hashPassword(password),
      includeRestricted: params.includeRestricted,
      createdBy: params.actorId,
      expiresAt,
    })
    .returning();
  await db.insert(auditLog).values({
    organizationId: params.organizationId,
    actorId: params.actorId,
    action: "view_link.created",
    entityType: "view_link",
    entityId: link.id,
    details: { label: link.label, days: params.days, includeRestricted: params.includeRestricted },
  });
  // The token and password exist only in this return value.
  return { link, token, password };
}

// The link if it's still usable (not switched off, not expired), else null.
export async function activeViewLink(db: DbOrTx, id: string, organizationId: string) {
  const [link] = await db
    .select()
    .from(viewLinks)
    .where(and(eq(viewLinks.id, id), eq(viewLinks.organizationId, organizationId), isNull(viewLinks.revokedAt), gt(viewLinks.expiresAt, new Date())));
  return link ?? null;
}

// Checks the password for a link. Wrong passwords count toward a lockout
// and, eventually, switching the link off. Unknown, expired and switched-off
// links all get the same answer.
export async function unlockViewLink(db: DbOrTx, token: string, password: string) {
  const [link] = await db.select().from(viewLinks).where(eq(viewLinks.tokenHash, sha256(token)));
  const now = new Date();
  if (!link || link.revokedAt || link.expiresAt <= now) {
    throw new ViewLinkError("This link is invalid, has expired, or has been switched off.", "invalid");
  }
  if (link.lockedUntil && link.lockedUntil > now) {
    throw new ViewLinkError("Too many wrong passwords. Try again in a few minutes.", "locked");
  }
  if (!passwordMatches(password, link.passwordHash)) {
    const failures = link.failedAttempts + 1;
    await db
      .update(viewLinks)
      .set({
        failedAttempts: failures,
        lockedUntil: failures % MAX_FAILURES_BEFORE_LOCK === 0 ? new Date(now.getTime() + LOCK_MINUTES * 60 * 1000) : link.lockedUntil,
        revokedAt: failures >= MAX_FAILURES_BEFORE_REVOKE ? now : null,
      })
      .where(eq(viewLinks.id, link.id));
    if (failures >= MAX_FAILURES_BEFORE_REVOKE) {
      await db.insert(auditLog).values({
        organizationId: link.organizationId,
        actorId: null,
        action: "view_link.auto_revoked",
        entityType: "view_link",
        entityId: link.id,
        details: { failedAttempts: failures },
      });
    }
    throw new ViewLinkError("That password isn't right.", "invalid");
  }
  await db.update(viewLinks).set({ failedAttempts: 0, lockedUntil: null, lastUsedAt: now }).where(eq(viewLinks.id, link.id));
  await db.insert(auditLog).values({
    organizationId: link.organizationId,
    actorId: null,
    action: "view_link.opened",
    entityType: "view_link",
    entityId: link.id,
    details: { label: link.label },
  });
  return link;
}

export async function listViewLinks(db: DbOrTx, organizationId: string) {
  const rows = await db
    .select({
      id: viewLinks.id,
      label: viewLinks.label,
      includeRestricted: viewLinks.includeRestricted,
      createdAt: viewLinks.createdAt,
      expiresAt: viewLinks.expiresAt,
      revokedAt: viewLinks.revokedAt,
      lastUsedAt: viewLinks.lastUsedAt,
      lockedUntil: viewLinks.lockedUntil,
      createdByName: users.name,
    })
    .from(viewLinks)
    .innerJoin(users, eq(users.id, viewLinks.createdBy))
    .where(eq(viewLinks.organizationId, organizationId))
    .orderBy(desc(viewLinks.createdAt));
  const now = new Date();
  return rows.map((r) => ({ ...r, active: !r.revokedAt && r.expiresAt > now }));
}

export async function revokeViewLink(db: DbOrTx, params: { organizationId: string; actorId: string; id: string }) {
  const [link] = await db
    .update(viewLinks)
    .set({ revokedAt: new Date() })
    .where(and(eq(viewLinks.id, params.id), eq(viewLinks.organizationId, params.organizationId), isNull(viewLinks.revokedAt)))
    .returning();
  if (!link) return false;
  await db.insert(auditLog).values({
    organizationId: params.organizationId,
    actorId: params.actorId,
    action: "view_link.revoked",
    entityType: "view_link",
    entityId: link.id,
    details: { label: link.label },
  });
  return true;
}
