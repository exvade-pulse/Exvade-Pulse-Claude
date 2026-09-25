import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { and, count, desc, eq, gte, inArray } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { decisions, sources, suggestions } from "../db/schema.js";
import { authenticateChatGptKey } from "../integrations/manage.js";
import { runInterpretationPipeline } from "../interpretation/pipeline.js";
import { listRelationshipsForEntity } from "../relationships/manage.js";
import { describeSuggestions } from "../suggestions/describe.js";
import { loadCompanyMapTree, loadTaskDetail } from "./companyMap.js";
import { deriveSubject } from "./sources.js";
import { UUID_RE } from "./uuid.js";

declare module "fastify" {
  interface FastifyRequest {
    chatgpt?: { integrationId: string; organizationId: string };
  }
}

// Every comment runs a paid Claude interpretation call and lands in the
// review queue, so a runaway conversation must not be able to flood either.
export const CHATGPT_DAILY_COMMENT_LIMIT = 25;
const MAX_COMMENT_LENGTH = 10_000;
const TASK_HISTORY_LIMIT = 10;
const REVIEW_LIMIT = 100;

// The org's admin chose to let their assistant see every visibility level,
// so reads run with admin-equivalent visibility. Writes are still impossible:
// the only write path is a comment, which becomes pending suggestions.
const CHATGPT_ROLE = "admin" as const;

async function requireChatGptKey(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const header = request.headers.authorization;
  const key = header?.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
  const match = key ? await authenticateChatGptKey(db, key) : null;
  if (!match) {
    reply.code(401).send({ error: "Missing or invalid Pulse API key" });
    return;
  }
  request.chatgpt = match;
}

function openApiSpec() {
  const json = (description: string) => ({
    description,
    content: { "application/json": { schema: { type: "object" } } },
  });
  return {
    openapi: "3.1.0",
    info: {
      title: "Exvade Pulse",
      version: "1.0.0",
      description:
        "Read Exvade Bioscience's operational state (objectives, initiatives, projects, tasks, open decisions, the review queue) and send comments for human review. Nothing sent here changes data directly: every comment becomes a pending suggestion a person approves or rejects in Pulse.",
    },
    servers: [{ url: config.backendUrl }],
    components: { securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } } },
    security: [{ bearerAuth: [] }],
    paths: {
      "/api/public/chatgpt/overview": {
        get: {
          operationId: "getCompanyOverview",
          summary: "Full company map: every objective, initiative, project and task with status, owner, latest update, next action and last-updated date, plus open decisions and how many suggestions await review.",
          responses: { "200": json("The company overview") },
        },
      },
      "/api/public/chatgpt/tasks/{taskId}": {
        get: {
          operationId: "getTask",
          summary: "One task in detail: description, where it sits in the hierarchy, its approved update history, any open decision blocking it, and its relationships to other work. Use a task id from getCompanyOverview.",
          parameters: [{ name: "taskId", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": json("The task"), "404": json("No such task") },
        },
      },
      "/api/public/chatgpt/decisions": {
        get: {
          operationId: "listOpenDecisions",
          summary: "Every open decision, with who decides, why it matters, context, suggested next step and due date.",
          responses: { "200": json("Open decisions") },
        },
      },
      "/api/public/chatgpt/review": {
        get: {
          operationId: "listPendingReview",
          summary: "Suggested changes currently waiting for a person to approve or reject in Pulse, with the AI's reasoning and confidence for each.",
          responses: { "200": json("Pending suggestions") },
        },
      },
      "/api/public/chatgpt/comments": {
        post: {
          operationId: "sendCommentToPulse",
          summary: "Send a comment, update or recommendation about the work into Pulse. Pulse turns it into suggested changes that wait in its review queue for a person to approve -- it never changes anything directly. Always show the user the exact comment and get their go-ahead before calling this.",
          "x-openai-isConsequential": true,
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["comment"],
                  properties: {
                    comment: {
                      type: "string",
                      description: "The comment in plain language. Name the specific task, project or decision it's about so Pulse can match it.",
                    },
                  },
                },
              },
            },
          },
          responses: {
            "200": json("What Pulse did with the comment"),
            "429": json("Daily comment limit reached"),
          },
        },
      },
    },
  };
}

export async function chatGptRoutes(app: FastifyInstance) {
  // Unauthenticated on purpose: it's what ChatGPT's "Import from URL" fetches,
  // and it contains no data or secrets -- only the shape of the API.
  app.get("/api/public/chatgpt/openapi.json", async (_request, reply) => {
    reply.send(openApiSpec());
  });

  await app.register(async (authed) => {
    authed.addHook("preHandler", requireChatGptKey);

    authed.get("/api/public/chatgpt/overview", async (request, reply) => {
      const organizationId = request.chatgpt!.organizationId;
      const [objectives, openDecisions, [pending]] = await Promise.all([
        loadCompanyMapTree(organizationId, CHATGPT_ROLE),
        db
          .select({ id: decisions.id, title: decisions.title, decider: decisions.decider, dueDate: decisions.dueDate })
          .from(decisions)
          .where(and(eq(decisions.organizationId, organizationId), eq(decisions.status, "open")))
          .orderBy(decisions.dueDate),
        db
          .select({ count: count() })
          .from(suggestions)
          .where(and(eq(suggestions.organizationId, organizationId), inArray(suggestions.status, ["pending", "edited"]))),
      ]);
      reply.send({ objectives, openDecisions, pendingReviewCount: pending?.count ?? 0 });
    });

    authed.get<{ Params: { taskId: string } }>("/api/public/chatgpt/tasks/:taskId", async (request, reply) => {
      const organizationId = request.chatgpt!.organizationId;
      const { taskId } = request.params;
      const detail = UUID_RE.test(taskId) ? await loadTaskDetail(organizationId, taskId, CHATGPT_ROLE) : null;
      if (!detail) {
        reply.code(404).send({ error: "Task not found" });
        return;
      }
      const relationships = await listRelationshipsForEntity(db, organizationId, "task", taskId);
      reply.send({
        ...detail,
        approvedSuggestions: detail.approvedSuggestions.slice(0, TASK_HISTORY_LIMIT),
        relationships,
      });
    });

    authed.get("/api/public/chatgpt/decisions", async (request, reply) => {
      const rows = await db
        .select({
          id: decisions.id,
          title: decisions.title,
          decider: decisions.decider,
          stakeholders: decisions.stakeholders,
          whyItMatters: decisions.whyItMatters,
          relevantContext: decisions.relevantContext,
          suggestedNextStep: decisions.suggestedNextStep,
          dueDate: decisions.dueDate,
          relatedTaskId: decisions.relatedTaskId,
          updatedAt: decisions.updatedAt,
        })
        .from(decisions)
        .where(and(eq(decisions.organizationId, request.chatgpt!.organizationId), eq(decisions.status, "open")))
        .orderBy(decisions.dueDate);
      reply.send({ decisions: rows });
    });

    authed.get("/api/public/chatgpt/review", async (request, reply) => {
      const organizationId = request.chatgpt!.organizationId;
      const rows = await db
        .select({
          id: suggestions.id,
          targetType: suggestions.targetType,
          targetId: suggestions.targetId,
          changeType: suggestions.changeType,
          proposedDiff: suggestions.proposedDiff,
          reasoning: suggestions.reasoning,
          confidence: suggestions.confidence,
          createdAt: suggestions.createdAt,
          sourceType: sources.type,
        })
        .from(suggestions)
        .innerJoin(sources, eq(sources.id, suggestions.sourceId))
        .where(and(eq(suggestions.organizationId, organizationId), inArray(suggestions.status, ["pending", "edited"])))
        .orderBy(desc(suggestions.createdAt))
        .limit(REVIEW_LIMIT);

      const about = await describeSuggestions(db, organizationId, rows);
      reply.send({ suggestions: rows.map((row) => ({ ...row, about: about.get(row.id) })) });
    });

    authed.post<{ Body: { comment?: unknown } }>("/api/public/chatgpt/comments", async (request, reply) => {
      const organizationId = request.chatgpt!.organizationId;
      const comment = typeof request.body?.comment === "string" ? request.body.comment.trim() : "";
      if (!comment) {
        reply.code(400).send({ error: "comment is required" });
        return;
      }
      if (comment.length > MAX_COMMENT_LENGTH) {
        reply.code(400).send({ error: `comment must be at most ${MAX_COMMENT_LENGTH} characters` });
        return;
      }

      const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const [recent] = await db
        .select({ count: count() })
        .from(sources)
        .where(and(eq(sources.organizationId, organizationId), eq(sources.type, "chatgpt"), gte(sources.createdAt, since)));
      if ((recent?.count ?? 0) >= CHATGPT_DAILY_COMMENT_LIMIT) {
        reply.code(429).send({
          error: `Daily limit of ${CHATGPT_DAILY_COMMENT_LIMIT} comments reached. Try again tomorrow, or add it directly in Pulse with "Add update".`,
        });
        return;
      }

      const result = await runInterpretationPipeline(db, organizationId, {
        type: "chatgpt",
        externalId: randomUUID(),
        subject: deriveSubject(comment),
        from: "ChatGPT assistant",
        body: comment,
        receivedAt: new Date(),
      });

      const created = result.suggestionIds.length;
      reply.send({
        suggestionsCreated: created,
        skippedAsNoise: result.skippedAsNoise,
        message: result.skippedAsNoise
          ? "Pulse read the comment but found nothing actionable in it, so nothing was added to review."
          : `Sent. ${created} suggested change${created === 1 ? " is" : "s are"} now waiting in Pulse's Review queue for approval. Nothing was changed directly.`,
      });
    });
  });
}
