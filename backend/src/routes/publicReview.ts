import type { FastifyInstance } from "fastify";
import { db } from "../db/client.js";
import { buildExecutiveReview } from "../reports/executiveReview.js";
import { resolveReviewLink } from "../reports/reviewLinks.js";

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const PRIVATE_HEADERS = {
  "X-Robots-Tag": "noindex, nofollow, noarchive, nosnippet",
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
};

export async function publicReviewRoutes(app: FastifyInstance) {
  // Nothing under /api/public is meant for search engines -- belt and braces
  // alongside each review page's own noindex header.
  app.get("/robots.txt", async (_request, reply) => {
    reply.type("text/plain").send("User-agent: *\nDisallow: /\n");
  });

  // Plain server-rendered HTML, not the Next.js app: ChatGPT's browsing may
  // not run JavaScript, and it can't sign in -- the signed token in the URL
  // is the only credential (a query param, like the webhook routes: a signed
  // token is longer than Fastify's 100-char path-param limit). Always built
  // fresh, so the link shows the current state for its whole 7-day life.
  app.get<{ Querystring: { token?: string } }>("/api/public/review", async (request, reply) => {
    const token = request.query.token;
    const link = token ? await resolveReviewLink(db, token) : null;
    reply.headers(PRIVATE_HEADERS);
    if (!link) {
      reply.code(404).type("text/plain").send("This review link has expired or was turned off. Create a new one from the Pulse dashboard.");
      return;
    }

    const text = await buildExecutiveReview(link.organizationId, "admin");
    reply
      .type("text/html; charset=utf-8")
      .send(
        `<!doctype html><html><head><meta charset="utf-8"><meta name="robots" content="noindex, nofollow, noarchive">` +
          `<title>Exvade Pulse — Executive Review</title></head>` +
          `<body><pre style="white-space: pre-wrap; font-family: system-ui, sans-serif; max-width: 900px; margin: 24px auto; line-height: 1.5">${escapeHtml(text)}</pre></body></html>`,
      );
  });
}
