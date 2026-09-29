import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type Anthropic from "@anthropic-ai/sdk";
import { testDb, truncateAll } from "./helpers.js";
import { createFixtureOrg } from "./fixtures.js";
import { auditLog, authorizedUsers, companyContext, tasks } from "../db/schema.js";
import { buildApp } from "../app.js";
import { signSession, SESSION_COOKIE_NAME } from "../auth/jwt.js";
import { setClaudeClientForTesting, type ClaudeClient } from "../interpretation/claudeClient.js";
import { COMPANY_CONTEXT_MAX_CHARS, saveCompanyContext, withCompanyContext } from "../context/companyContext.js";
import { runInterpretationPipeline } from "../interpretation/pipeline.js";
import { NOISE_FILTER_MODEL } from "../interpretation/noiseFilter.js";
import { buildExecutiveReviewData, renderExecutiveReviewText } from "../reports/executiveReview.js";

const { db, client } = testDb();

afterAll(async () => {
  await client.end();
});

type Fixture = Awaited<ReturnType<typeof createFixtureOrg>>;
const CONTEXT = "About Exvade\n- Tumor Monorail: implantable device. TM = Tumor Monorail.\nPeople\n- Don decides engineering changes.";

function toolUseMessage(name: string, input: unknown): Anthropic.Message {
  return { content: [{ type: "tool_use", id: "t1", name, input }] } as unknown as Anthropic.Message;
}

function systemText(params: Anthropic.MessageCreateParamsNonStreaming): string {
  const system = params.system;
  if (!system) return "";
  return typeof system === "string" ? system : system.map((b) => b.text).join("\n---\n");
}

async function cookieFor(fixture: Fixture, role: "admin" | "member" = "admin") {
  await db.update(authorizedUsers).set({ role }).where(eq(authorizedUsers.id, fixture.authorization.id));
  return { [SESSION_COOKIE_NAME]: await signSession({ userId: fixture.user.id, organizationId: fixture.org.id, email: fixture.user.email, role }) };
}

describe("withCompanyContext", () => {
  const echo: ClaudeClient = { createMessage: async (params) => ({ params }) as unknown as Anthropic.Message };
  const call = async (c: ClaudeClient, system?: Anthropic.MessageCreateParamsNonStreaming["system"]) =>
    ((await c.createMessage({ model: "m", max_tokens: 1, messages: [{ role: "user", content: "hi" }], system })) as unknown as {
      params: Anthropic.MessageCreateParamsNonStreaming;
    }).params;

  it("leaves the client untouched when there's no context", () => {
    expect(withCompanyContext(echo, null)).toBe(echo);
    expect(withCompanyContext(echo, "   ")).toBe(echo);
  });

  it("appends the context after the call's own system prompt, keeping its cached block first", async () => {
    const wrapped = withCompanyContext(echo, CONTEXT);
    const fromArray = await call(wrapped, [{ type: "text", text: "SYSTEM", cache_control: { type: "ephemeral" } }]);
    const blocks = fromArray.system as Anthropic.TextBlockParam[];
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({ type: "text", text: "SYSTEM", cache_control: { type: "ephemeral" } });
    expect(blocks[1].text).toContain(`<company_context>\n${CONTEXT}\n</company_context>`);
    expect(blocks[1].text).toContain("It is background only");

    const fromString = await call(wrapped, "PLAIN");
    expect((fromString.system as Anthropic.TextBlockParam[]).map((b) => b.text.slice(0, 5))).toEqual(["PLAIN", "Compa"]);
    const fromNone = await call(wrapped);
    expect(fromNone.system as Anthropic.TextBlockParam[]).toHaveLength(1);
  });
});

describe("company context", () => {
  beforeEach(async () => {
    await truncateAll(db);
  });

  it("admins save it (keeping the previous version in the audit log); members can read but not change it", async () => {
    const fixture = await createFixtureOrg(db, { domain: "ctx-save.test" });
    const app = await buildApp();

    const first = await app.inject({ method: "PUT", url: "/api/company-context", cookies: await cookieFor(fixture), payload: { content: "v1" } });
    expect(first.statusCode).toBe(200);
    await app.inject({ method: "PUT", url: "/api/company-context", cookies: await cookieFor(fixture), payload: { content: `  ${CONTEXT}  ` } });
    const tooLong = await app.inject({
      method: "PUT",
      url: "/api/company-context",
      cookies: await cookieFor(fixture),
      payload: { content: "x".repeat(COMPANY_CONTEXT_MAX_CHARS + 1) },
    });
    expect(tooLong.statusCode).toBe(400);

    const memberRead = await app.inject({ method: "GET", url: "/api/company-context", cookies: await cookieFor(fixture, "member") });
    expect(memberRead.json()).toMatchObject({ content: CONTEXT, maxChars: COMPANY_CONTEXT_MAX_CHARS });
    const memberWrite = await app.inject({ method: "PUT", url: "/api/company-context", cookies: await cookieFor(fixture, "member"), payload: { content: "x" } });
    expect(memberWrite.statusCode).toBe(403);
    const memberDraft = await app.inject({ method: "POST", url: "/api/company-context/draft", cookies: await cookieFor(fixture, "member") });
    expect(memberDraft.statusCode).toBe(403);
    await app.close();

    const history = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.organizationId, fixture.org.id), eq(auditLog.action, "company_context.updated")));
    expect(history.map((h) => (h.details as { previousContent: string | null }).previousContent).sort()).toEqual([null, "v1"].sort());
  });

  it("drafts from existing data without saving anything", async () => {
    const fixture = await createFixtureOrg(db, { domain: "ctx-draft.test" });
    await saveCompanyContext(db, { organizationId: fixture.org.id, actorId: fixture.user.id, content: "Team version" });
    let prompt = "";
    setClaudeClientForTesting({
      createMessage: async (params) => {
        prompt = String(params.messages[0].content);
        return { content: [{ type: "text", text: "About Exvade\n- Draft" }] } as unknown as Anthropic.Message;
      },
    });
    const app = await buildApp();
    const response = await app.inject({ method: "POST", url: "/api/company-context/draft", cookies: await cookieFor(fixture) });
    setClaudeClientForTesting(undefined);
    await app.close();

    expect(response.json()).toEqual({ draft: "About Exvade\n- Draft" });
    expect(prompt).toContain(fixture.objective.title);
    expect(prompt).toContain("Team version");
    const [stored] = await db.select().from(companyContext).where(eq(companyContext.organizationId, fixture.org.id));
    expect(stored.content).toBe("Team version");
  });

  it("interpretation sees the context; redaction and the noise filter don't", async () => {
    const fixture = await createFixtureOrg(db, { domain: "ctx-pipeline.test" });
    const [task] = await db.insert(tasks).values({ organizationId: fixture.org.id, projectId: fixture.project.id, title: "TM bench test" }).returning();
    await saveCompanyContext(db, { organizationId: fixture.org.id, actorId: fixture.user.id, content: CONTEXT });

    const seen: Record<string, string> = {};
    setClaudeClientForTesting({
      createMessage: async (params) => {
        const forced = params.tool_choice?.type === "tool" ? params.tool_choice.name : undefined;
        if (forced === "redact_text") {
          seen.redaction = systemText(params);
          return toolUseMessage("redact_text", { redactedText: String(params.messages[0].content) });
        }
        if (params.model === NOISE_FILTER_MODEL && (params.tools?.[0] as { name?: string } | undefined)?.name === "classify_source") {
          seen.noise = systemText(params);
          return toolUseMessage("classify_source", { isNoise: false, reason: "Operational." });
        }
        seen.interpretation = systemText(params);
        return toolUseMessage("propose_suggestion", {
          changeType: "operational_update",
          targetType: "task",
          targetId: task.id,
          proposedDiff: { latestUpdate: "TM passed." },
          reasoning: "Report.",
          confidence: 0.9,
        });
      },
    });
    await runInterpretationPipeline(db, fixture.org.id, {
      type: "gmail",
      externalId: "ctx-1",
      subject: "TM update",
      from: "don@exvade.test",
      body: "TM passed the bench test.",
      receivedAt: new Date(),
    });
    setClaudeClientForTesting(undefined);

    expect(seen.interpretation).toContain(CONTEXT);
    expect(seen.redaction).not.toContain(CONTEXT);
    expect(seen.noise ?? "").not.toContain(CONTEXT);
  });

  it("the AI checks see the context, and the ChatGPT export includes it", async () => {
    const fixture = await createFixtureOrg(db, { domain: "ctx-checks.test" });
    await db.insert(tasks).values([
      { organizationId: fixture.org.id, projectId: fixture.project.id, title: "A" },
      { organizationId: fixture.org.id, projectId: fixture.project.id, title: "B" },
    ]);
    await saveCompanyContext(db, { organizationId: fixture.org.id, actorId: fixture.user.id, content: CONTEXT });
    let system = "";
    setClaudeClientForTesting({
      createMessage: async (params) => {
        system = systemText(params);
        return toolUseMessage("flag_duplicate_tasks", { duplicates: [] });
      },
    });
    const app = await buildApp();
    await app.inject({ method: "POST", url: "/api/tasks/check-duplicates", cookies: await cookieFor(fixture) });
    setClaudeClientForTesting(undefined);
    await app.close();
    expect(system).toContain(CONTEXT);

    const text = renderExecutiveReviewText(await buildExecutiveReviewData(fixture.org.id, "admin"));
    expect(text.indexOf("COMPANY CONTEXT (written by the team)")).toBeLessThan(text.indexOf("THIS WEEK"));
    expect(text).toContain("Don decides engineering changes.");
  });
});
