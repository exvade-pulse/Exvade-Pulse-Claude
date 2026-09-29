import type { FastifyRequest } from "fastify";
import { config } from "../config.js";

// The website proxies /api and /auth through its own domain (see the
// frontend's lib/backendProxy.ts) so the session cookie is first-party and
// isn't blocked by Safari, Incognito, Brave, etc. A sign-in that started
// through that proxy must also come back through it -- the OAuth state
// cookie and the session cookie live on the website's domain -- so Google is
// told to return to the website's address. Direct requests keep the
// configured callback. Spoofing the header can only pick between the
// callback URLs already registered with Google, so it grants nothing.
export function viaFrontendProxy(request: FastifyRequest): boolean {
  return request.headers["x-pulse-proxy"] === "1";
}

export function oauthCallbackUrl(request: FastifyRequest, path: "/auth/google/callback" | "/auth/gmail/callback", direct: string): string {
  return viaFrontendProxy(request) ? `${config.frontendUrl.replace(/\/$/, "")}${path}` : direct;
}
