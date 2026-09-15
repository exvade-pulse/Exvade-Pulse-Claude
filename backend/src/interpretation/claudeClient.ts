import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";

// Every Claude API call in the interpretation pipeline goes through this one
// interface, so the model provider/version is swappable and tests can stub it
// out at this boundary instead of mocking the Anthropic SDK module directly.
export interface ClaudeClient {
  createMessage(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
}

class AnthropicClaudeClient implements ClaudeClient {
  private readonly sdk: Anthropic;

  constructor(apiKey: string) {
    this.sdk = new Anthropic({ apiKey });
  }

  createMessage(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> {
    return this.sdk.messages.create(params);
  }
}

let client: ClaudeClient | undefined;

// Constructed lazily (and only once) so importing this module -- or anything
// that imports it -- never requires ANTHROPIC_API_KEY to be set. The app must
// still boot and the test suite must still pass without a real key.
export function getClaudeClient(): ClaudeClient {
  if (!client) {
    if (!config.anthropicApiKey) {
      throw new Error("ANTHROPIC_API_KEY is not set; cannot call the Claude API.");
    }
    client = new AnthropicClaudeClient(config.anthropicApiKey);
  }
  return client;
}

// Test-only escape hatch: inject a fake implementation instead of the real SDK.
// Pass undefined to clear it back to the lazily-constructed real client.
export function setClaudeClientForTesting(fake: ClaudeClient | undefined): void {
  client = fake;
}
