import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type Anthropic from "@anthropic-ai/sdk";
import { testDb, truncateAll } from "./helpers.js";
import { createFixtureOrg } from "./fixtures.js";
import { gmailConnections, sources, suggestions } from "../db/schema.js";
import { syncGmailConnection } from "../integrations/gmailSync.js";
import { setClaudeClientForTesting, type ClaudeClient } from "../interpretation/claudeClient.js";
import { NOISE_FILTER_MODEL } from "../interpretation/noiseFilter.js";
import { INTERPRETATION_MODEL } from "../interpretation/interpret.js";

const { db, client } = testDb();

afterAll(async () => {
  await client.end();
});

afterEach(() => {
  vi.unstubAllGlobals();
  setClaudeClientForTesting(undefined);
});

function toolUseMessage(name: string, input: unknown): Anthropic.Message {
  return { content: [{ type: "tool_use", id: "t1", name, input }] } as unknown as Anthropic.Message;
}

function forcedToolName(params: Anthropic.MessageCreateParamsNonStreaming): string | undefined {
  return params.tool_choice?.type === "tool" ? params.tool_choice.name : undefined;
}

function notNoiseThenSuggestionClient(): ClaudeClient {
  return {
    createMessage: async (params) => {
      if (forcedToolName(params) === "redact_text") {
        const body = params.messages[0]?.content as string;
        return toolUseMessage("redact_text", { redactedText: body });
      }
      if (params.model === NOISE_FILTER_MODEL) {
        return toolUseMessage("classify_source", { isNoise: false, reason: "Has real content." });
      }
      expect(params.model).toBe(INTERPRETATION_MODEL);
      return toolUseMessage("propose_suggestion", {
        changeType: "new_task",
        targetType: "task",
        targetId: null,
        proposedDiff: { title: "Follow up from Gmail", projectId: null },
        reasoning: "New item mentioned.",
        confidence: 0.7,
      });
    },
  };
}

function b64url(text: string): string {
  return Buffer.from(text, "utf-8").toString("base64url");
}

function gmailMessage(id: string, subject: string, body: string) {
  return {
    id,
    historyId: `hist-${id}`,
    internalDate: String(Date.now()),
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "Subject", value: subject },
        { name: "From", value: "someone@example.com" },
      ],
      body: { data: b64url(body) },
    },
  };
}

// Dispatches on URL/query shape rather than a fixed sequence, since sync
// logic branches (first sync vs incremental) determine call order.
function stubGmailApi(opts: {
  profileHistoryId: string;
  inboxMessageIds?: string[];
  historyMessageIds?: string[];
  historyExpired?: boolean;
  messages: Record<string, ReturnType<typeof gmailMessage>>;
}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.includes("oauth2.googleapis.com/token")) {
        return { ok: true, json: async () => ({ access_token: "access-token", expires_in: 3600 }) };
      }
      if (url.includes("/profile")) {
        return { ok: true, json: async () => ({ emailAddress: "pulse@exvadebio.com", historyId: opts.profileHistoryId }) };
      }
      if (url.includes("/history?")) {
        if (opts.historyExpired) {
          return { ok: false, status: 404, text: async () => "history expired" };
        }
        return {
          ok: true,
          json: async () => ({
            history: (opts.historyMessageIds ?? []).map((id) => ({ messagesAdded: [{ message: { id } }] })),
          }),
        };
      }
      if (url.includes("/messages?")) {
        return { ok: true, json: async () => ({ messages: (opts.inboxMessageIds ?? []).map((id) => ({ id })) }) };
      }
      const messageMatch = url.match(/\/messages\/([^?]+)\?/);
      if (messageMatch) {
        const message = opts.messages[messageMatch[1]];
        if (!message) throw new Error(`No stubbed message for id ${messageMatch[1]}`);
        return { ok: true, json: async () => message };
      }
      throw new Error(`Unexpected Gmail API call: ${url}`);
    }),
  );
}

describe("syncGmailConnection", () => {
  beforeEach(async () => {
    await truncateAll(db);
  });

  it("throws when there's no connection for the org", async () => {
    const fixture = await createFixtureOrg(db, { domain: "gmail-sync-no-connection.test" });
    await expect(syncGmailConnection(db, fixture.org.id)).rejects.toThrow(/No Gmail connection/);
  });

  it("first sync: lists the whole inbox, ingests each message, and sets the historyId baseline", async () => {
    const fixture = await createFixtureOrg(db, { domain: "gmail-sync-first.test" });
    await db.insert(gmailConnections).values({
      organizationId: fixture.org.id,
      emailAddress: "pulse@exvadebio.com",
      refreshToken: "refresh-1",
      connectedBy: fixture.user.id,
    });

    stubGmailApi({
      profileHistoryId: "1000",
      inboxMessageIds: ["msg-1", "msg-2"],
      messages: {
        "msg-1": gmailMessage("msg-1", "First message", "Please follow up on the vendor quote."),
        "msg-2": gmailMessage("msg-2", "Second message", "Reminder about the site visit next week."),
      },
    });
    setClaudeClientForTesting(notNoiseThenSuggestionClient());

    const result = await syncGmailConnection(db, fixture.org.id);
    expect(result.messagesFound).toBe(2);
    expect(result.suggestionsCreated).toBe(2);
    expect(result.errors).toBe(0);

    const sourceRows = await db
      .select()
      .from(sources)
      .where(eq(sources.organizationId, fixture.org.id));
    // +1 for the fixture's own pre-seeded gmail source.
    expect(sourceRows.filter((s) => s.type === "gmail")).toHaveLength(3);

    const [connection] = await db.select().from(gmailConnections).where(eq(gmailConnections.organizationId, fixture.org.id));
    expect(connection.lastHistoryId).toBe("1000");
    expect(connection.lastSyncedAt).not.toBeNull();
    expect(connection.lastSyncError).toBeNull();
  });

  it("incremental sync: only processes messages from history.list, not a full re-scan", async () => {
    const fixture = await createFixtureOrg(db, { domain: "gmail-sync-incremental.test" });
    await db.insert(gmailConnections).values({
      organizationId: fixture.org.id,
      emailAddress: "pulse@exvadebio.com",
      refreshToken: "refresh-1",
      lastHistoryId: "500",
      connectedBy: fixture.user.id,
    });

    stubGmailApi({
      profileHistoryId: "600",
      historyMessageIds: ["msg-new"],
      messages: { "msg-new": gmailMessage("msg-new", "New mail", "A brand new item to track.") },
    });
    setClaudeClientForTesting(notNoiseThenSuggestionClient());

    const result = await syncGmailConnection(db, fixture.org.id);
    expect(result.messagesFound).toBe(1);
    expect(result.suggestionsCreated).toBe(1);

    const [connection] = await db.select().from(gmailConnections).where(eq(gmailConnections.organizationId, fixture.org.id));
    expect(connection.lastHistoryId).toBe("600");
  });

  it("falls back to a full re-scan when Gmail reports the stored historyId has expired", async () => {
    const fixture = await createFixtureOrg(db, { domain: "gmail-sync-expired.test" });
    await db.insert(gmailConnections).values({
      organizationId: fixture.org.id,
      emailAddress: "pulse@exvadebio.com",
      refreshToken: "refresh-1",
      lastHistoryId: "very-old-id",
      connectedBy: fixture.user.id,
    });

    stubGmailApi({
      profileHistoryId: "9999",
      historyExpired: true,
      inboxMessageIds: ["msg-fallback"],
      messages: { "msg-fallback": gmailMessage("msg-fallback", "Fallback scan", "Picked up via full re-scan.") },
    });
    setClaudeClientForTesting(notNoiseThenSuggestionClient());

    const result = await syncGmailConnection(db, fixture.org.id);
    expect(result.messagesFound).toBe(1);

    const [connection] = await db.select().from(gmailConnections).where(eq(gmailConnections.organizationId, fixture.org.id));
    expect(connection.lastHistoryId).toBe("9999");
  });

  it("a message that's already been ingested (duplicate externalId) is skipped, not counted as an error", async () => {
    const fixture = await createFixtureOrg(db, { domain: "gmail-sync-dup.test" });
    await db.insert(gmailConnections).values({
      organizationId: fixture.org.id,
      emailAddress: "pulse@exvadebio.com",
      refreshToken: "refresh-1",
      connectedBy: fixture.user.id,
    });
    // Pre-existing source with the same externalId the sync will encounter.
    await db.insert(sources).values({
      organizationId: fixture.org.id,
      type: "gmail",
      externalId: "already-ingested",
      receivedAt: new Date(),
      rawBody: "already here",
    });

    stubGmailApi({
      profileHistoryId: "100",
      inboxMessageIds: ["already-ingested"],
      messages: { "already-ingested": gmailMessage("already-ingested", "Dup", "This was already ingested.") },
    });
    setClaudeClientForTesting(notNoiseThenSuggestionClient());

    const result = await syncGmailConnection(db, fixture.org.id);
    expect(result.errors).toBe(0);
    expect(result.suggestionsCreated).toBe(0);
  });

  it("records lastSyncError and rethrows when the access token can't be refreshed", async () => {
    const fixture = await createFixtureOrg(db, { domain: "gmail-sync-token-fail.test" });
    await db.insert(gmailConnections).values({
      organizationId: fixture.org.id,
      emailAddress: "pulse@exvadebio.com",
      refreshToken: "revoked-refresh",
      connectedBy: fixture.user.id,
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 400, text: async () => "invalid_grant" })),
    );

    await expect(syncGmailConnection(db, fixture.org.id)).rejects.toThrow();

    const [connection] = await db.select().from(gmailConnections).where(eq(gmailConnections.organizationId, fixture.org.id));
    expect(connection.lastSyncError).not.toBeNull();
  });

  it("is org-isolated: syncing one org never touches another org's sources", async () => {
    const orgA = await createFixtureOrg(db, { domain: "gmail-sync-iso-a.test" });
    const orgB = await createFixtureOrg(db, { domain: "gmail-sync-iso-b.test" });
    await db.insert(gmailConnections).values({
      organizationId: orgA.org.id,
      emailAddress: "a@exvadebio.com",
      refreshToken: "refresh-a",
      connectedBy: orgA.user.id,
    });

    stubGmailApi({
      profileHistoryId: "1",
      inboxMessageIds: ["msg-a"],
      messages: { "msg-a": gmailMessage("msg-a", "For org A", "Only org A should get this.") },
    });
    setClaudeClientForTesting(notNoiseThenSuggestionClient());

    await syncGmailConnection(db, orgA.org.id);

    const orgBSources = await db.select().from(sources).where(eq(sources.organizationId, orgB.org.id));
    // Only orgB's own fixture-seeded source, nothing from orgA's sync.
    expect(orgBSources).toHaveLength(1);
    expect(orgBSources[0].id).toBe(orgB.source.id);
  });
});
