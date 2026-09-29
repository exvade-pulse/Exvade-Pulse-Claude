import { APIError } from "@anthropic-ai/sdk";
import type { ClaudeClient } from "./claudeClient.js";

// How many AI calls one check runs at the same time. Each call is exactly
// what it would be one-at-a-time; only the waiting overlaps.
export const AI_CONCURRENCY = 4;

// Runs fn over items with at most `limit` in flight, returning results in
// the original order -- so whatever the caller does with them afterwards
// happens exactly as it would have sequentially.
export async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

const MAX_RETRY_ATTEMPTS = 6;
const RETRY_BASE_BACKOFF_MS = 2000;

function isRetryableApiError(err: unknown): err is APIError {
  if (!(err instanceof APIError)) return false;
  return err.status === 429 || err.status === 529 || (err.status !== undefined && err.status >= 500);
}

// Retries a rate limit ("slow down") or a transient server error with
// backoff instead of failing the whole check -- more likely now that
// several calls run at once. Anything else passes straight through.
export function withRateLimitRetry(baseClient: ClaudeClient): ClaudeClient {
  return {
    async createMessage(params) {
      let attempt = 0;
      for (;;) {
        try {
          return await baseClient.createMessage(params);
        } catch (err) {
          attempt += 1;
          if (!isRetryableApiError(err) || attempt > MAX_RETRY_ATTEMPTS) throw err;
          const backoffMs = RETRY_BASE_BACKOFF_MS * 2 ** (attempt - 1) + Math.floor(Math.random() * 1000);
          console.warn(`Claude API returned ${err.status} (attempt ${attempt}/${MAX_RETRY_ATTEMPTS}); retrying in ${backoffMs}ms`);
          await new Promise((resolve) => setTimeout(resolve, backoffMs));
        }
      }
    },
  };
}
