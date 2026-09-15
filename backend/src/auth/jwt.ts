import { SignJWT, jwtVerify } from "jose";
import { config } from "../config.js";

export type UserRole = "member" | "admin";

export interface SessionClaims {
  userId: string;
  organizationId: string;
  email: string;
  // A hint for the UI (/auth/me, avoiding an extra round trip) -- NOT trusted
  // for authorization decisions. requireAuth re-reads the current role from
  // authorized_users on every request, since a 7-day-lived cookie must not
  // keep working with a role that's since been revoked or demoted.
  role: UserRole;
}

function secretKey() {
  return new TextEncoder().encode(config.sessionSecret);
}

export async function signSession(claims: SessionClaims): Promise<string> {
  return new SignJWT({ ...claims })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(secretKey());
}

export async function verifySession(token: string): Promise<SessionClaims | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey());
    if (
      typeof payload.userId === "string" &&
      typeof payload.organizationId === "string" &&
      typeof payload.email === "string" &&
      (payload.role === "member" || payload.role === "admin")
    ) {
      return {
        userId: payload.userId,
        organizationId: payload.organizationId,
        email: payload.email,
        role: payload.role,
      };
    }
    return null;
  } catch {
    return null;
  }
}

export const SESSION_COOKIE_NAME = "pulse_session";
