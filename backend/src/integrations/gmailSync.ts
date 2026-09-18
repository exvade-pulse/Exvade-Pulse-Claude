import { eq } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { gmailConnections } from "../db/schema.js";
import { refreshGmailAccessToken } from "./gmailOAuth.js";
import { parseGmailMessage, type GmailMessage } from "./gmailMime.js";
import { runInterpretationPipeline } from "../interpretation/pipeline.js";
import { isUniqueViolation } from "./webhookIngest.js";

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";
// Keeps a burst of new mail from hammering the Claude API back-to-back,
// mirroring importHistoricalMinutes.ts's DELAY_BETWEEN_DOCS_MS.
const DELAY_BETWEEN_MESSAGES_MS = 1500;
// Gmail's own cap per history.list/messages.list page; multiple pages are
// followed via pageToken rather than assuming a sync never needs more than one.
const PAGE_SIZE = 100;

async function gmailFetch(path: string, accessToken: string): Promise<unknown> {
  const response = await fetch(`${GMAIL_API}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    throw new Error(`Gmail API request failed (${response.status}): ${await response.text()}`);
  }
  return response.json();
}

// The very first sync has no historyId cursor yet -- lists everything
// currently in the inbox (this is a dedicated, purpose-built mailbox, so
// "everything" is the intended scope, not a filtered subset) and separately
// captures the mailbox's current historyId as the baseline for every sync
// after this one.
async function listAllMessageIds(accessToken: string): Promise<string[]> {
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const query = new URLSearchParams({ maxResults: String(PAGE_SIZE), labelIds: "INBOX" });
    if (pageToken) query.set("pageToken", pageToken);
    const page = (await gmailFetch(`/messages?${query.toString()}`, accessToken)) as {
      messages?: Array<{ id: string }>;
      nextPageToken?: string;
    };
    for (const m of page.messages ?? []) ids.push(m.id);
    pageToken = page.nextPageToken;
  } while (pageToken);
  return ids;
}

// Incremental sync: only messages added to the mailbox since lastHistoryId.
// If Gmail reports the historyId itself is too old (history has been purged,
// which happens after roughly a week of inactivity), the caller falls back
// to a full listAllMessageIds re-scan rather than silently missing mail.
async function listNewMessageIdsSince(accessToken: string, startHistoryId: string): Promise<string[] | "history_expired"> {
  const ids = new Set<string>();
  let pageToken: string | undefined;
  do {
    const query = new URLSearchParams({
      startHistoryId,
      historyTypes: "messageAdded",
      maxResults: String(PAGE_SIZE),
    });
    if (pageToken) query.set("pageToken", pageToken);

    const response = await fetch(`${GMAIL_API}/history?${query.toString()}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (response.status === 404) {
      // Google's documented signal for "startHistoryId no longer valid."
      return "history_expired";
    }
    if (!response.ok) {
      throw new Error(`Gmail history.list failed (${response.status}): ${await response.text()}`);
    }
    const page = (await response.json()) as {
      history?: Array<{ messagesAdded?: Array<{ message: { id: string } }> }>;
      nextPageToken?: string;
    };
    for (const entry of page.history ?? []) {
      for (const added of entry.messagesAdded ?? []) ids.add(added.message.id);
    }
    pageToken = page.nextPageToken;
  } while (pageToken);
  return [...ids];
}

async function currentHistoryId(accessToken: string): Promise<string> {
  const profile = (await gmailFetch("/profile", accessToken)) as { historyId: string };
  return profile.historyId;
}

// 5 minutes: frequent enough that new mail shows up promptly without being
// a real-time push, cheap enough (one history.list call when nothing's
// changed) not to matter at this scale. No persistent job queue exists in
// this codebase (see pipeline.ts's own note on webhook ingestion running
// synchronously in-request) -- an in-process interval is the same
// "simplest thing that works at this scale" choice, not a placeholder for
// something more robust.
const POLL_INTERVAL_MS = 5 * 60 * 1000;

// Started once at server boot (see index.ts). Every connected org's inbox is
// synced sequentially, not in parallel -- there's realistically one
// connection today, and serializing avoids several orgs' worth of Claude API
// calls landing at once if that ever changes.
export function startGmailPoller(db: Database): NodeJS.Timeout {
  async function pollOnce() {
    const connections = await db.select({ organizationId: gmailConnections.organizationId }).from(gmailConnections);
    for (const { organizationId } of connections) {
      try {
        await syncGmailConnection(db, organizationId);
      } catch (err) {
        console.error(`Gmail poller: sync failed for org ${organizationId}:`, err);
      }
    }
  }

  void pollOnce();
  return setInterval(() => {
    void pollOnce();
  }, POLL_INTERVAL_MS);
}

export interface GmailSyncResult {
  messagesFound: number;
  suggestionsCreated: number;
  errors: number;
}

// Runs one sync pass for one org's connected inbox: refresh the access
// token, figure out which messages are new (full listing on the first ever
// sync, incremental history.list after that), feed each through the same
// interpretation pipeline every other source type uses, and advance the
// stored cursor. Safe to call repeatedly/concurrently is NOT guaranteed --
// callers (the poller) are expected to serialize calls per org.
export async function syncGmailConnection(db: Database, organizationId: string): Promise<GmailSyncResult> {
  const [connection] = await db.select().from(gmailConnections).where(eq(gmailConnections.organizationId, organizationId));
  if (!connection) {
    throw new Error(`No Gmail connection for organization ${organizationId}`);
  }

  const result: GmailSyncResult = { messagesFound: 0, suggestionsCreated: 0, errors: 0 };

  try {
    const accessToken = await refreshGmailAccessToken(connection.refreshToken);

    let messageIds: string[];
    let isFirstSync = false;
    if (connection.lastHistoryId) {
      const since = await listNewMessageIdsSince(accessToken, connection.lastHistoryId);
      if (since === "history_expired") {
        messageIds = await listAllMessageIds(accessToken);
        isFirstSync = true;
      } else {
        messageIds = since;
      }
    } else {
      messageIds = await listAllMessageIds(accessToken);
      isFirstSync = true;
    }

    result.messagesFound = messageIds.length;

    // Captured before processing so a message that arrives mid-sync isn't
    // silently skipped by a cursor that's already moved past it.
    const newHistoryId = await currentHistoryId(accessToken);

    for (const messageId of messageIds) {
      try {
        const message = (await gmailFetch(`/messages/${messageId}?format=full`, accessToken)) as GmailMessage;
        const parsed = parseGmailMessage(message);
        const pipelineResult = await runInterpretationPipeline(db, organizationId, {
          type: "gmail",
          externalId: message.id,
          subject: parsed.subject,
          from: parsed.from,
          body: parsed.body,
          receivedAt: parsed.receivedAt,
        });
        result.suggestionsCreated += pipelineResult.suggestionIds.length;
      } catch (err) {
        if (isUniqueViolation(err)) continue; // already ingested -- not an error
        console.error(`Gmail sync: failed to process message ${messageId} for org ${organizationId}:`, err);
        result.errors++;
      }
      if (!isFirstSync || messageIds.length > 1) {
        await new Promise((r) => setTimeout(r, DELAY_BETWEEN_MESSAGES_MS));
      }
    }

    await db
      .update(gmailConnections)
      .set({ lastHistoryId: newHistoryId, lastSyncedAt: new Date(), lastSyncError: null, updatedAt: new Date() })
      .where(eq(gmailConnections.id, connection.id));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db
      .update(gmailConnections)
      .set({ lastSyncError: message, updatedAt: new Date() })
      .where(eq(gmailConnections.id, connection.id));
    throw err;
  }

  return result;
}
