import { createHash } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import { and, eq } from "drizzle-orm";
import { config } from "../config.js";
import type { Database } from "../db/client.js";
import { auditLog, webhookIntegrations } from "../db/schema.js";
import { generateIntegrationToken } from "../integrations/manage.js";

// A private, expiring link to the executive review that the user's ChatGPT
// can open with its ordinary web browsing (which can't sign in). The link is
// a signed token: no login, but unguessable, and it dies when it expires or
// when the org's ChatGPT key is rotated or turned off on the Integrations
// page -- the token carries a prefix of that key's hash and is checked
// against the live row on every open.

export const REVIEW_LINK_TTL_DAYS = 7;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Derived rather than the raw session secret, so a review-link token can
// never be mistaken for (or replayed as) a session cookie.
function signingKey(): Uint8Array {
  return createHash("sha256").update(`${config.sessionSecret}:executive-review-link`).digest();
}

async function chatGptIntegration(db: Database, organizationId: string) {
  const [row] = await db
    .select()
    .from(webhookIntegrations)
    .where(and(eq(webhookIntegrations.organizationId, organizationId), eq(webhookIntegrations.type, "chatgpt")));
  return row;
}

export async function createReviewLink(
  db: Database,
  params: { organizationId: string; actorId: string },
  now = new Date(),
): Promise<{ url: string; expiresAt: Date }> {
  let integration = await chatGptIntegration(db, params.organizationId);
  if (!integration) {
    // Links hang off the ChatGPT key so "Turn off" kills them; an admin who
    // never generated one just gets one silently (its raw value is unused).
    await generateIntegrationToken(db, { ...params, type: "chatgpt" });
    integration = await chatGptIntegration(db, params.organizationId);
  }

  const expiresAt = new Date(now.getTime() + REVIEW_LINK_TTL_DAYS * MS_PER_DAY);
  const token = await new SignJWT({ org: params.organizationId, k: integration!.tokenHash.slice(0, 16) })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt(Math.floor(now.getTime() / 1000))
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
    .sign(signingKey());

  await db.insert(auditLog).values({
    organizationId: params.organizationId,
    actorId: params.actorId,
    action: "review_link.created",
    entityType: "webhook_integration",
    entityId: integration!.id,
    details: { expiresAt: expiresAt.toISOString() },
  });

  return { url: `${config.backendUrl}/api/public/review?token=${token}`, expiresAt };
}

export async function resolveReviewLink(db: Database, token: string): Promise<{ organizationId: string } | null> {
  try {
    const { payload } = await jwtVerify(token, signingKey());
    if (typeof payload.org !== "string" || typeof payload.k !== "string") return null;
    const integration = await chatGptIntegration(db, payload.org);
    if (!integration || !integration.tokenHash.startsWith(payload.k)) return null;
    return { organizationId: payload.org };
  } catch {
    return null;
  }
}
