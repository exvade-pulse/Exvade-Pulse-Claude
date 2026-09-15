import { SignJWT, jwtVerify } from "jose";
import { config } from "../config.js";

export interface SessionClaims {
  userId: string;
  organizationId: string;
  email: string;
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
      typeof payload.email === "string"
    ) {
      return { userId: payload.userId, organizationId: payload.organizationId, email: payload.email };
    }
    return null;
  } catch {
    return null;
  }
}

export const SESSION_COOKIE_NAME = "pulse_session";
