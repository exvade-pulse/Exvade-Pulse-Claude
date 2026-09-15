import { afterEach, describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { isNoiseSource, NOISE_FILTER_MODEL } from "../interpretation/noiseFilter.js";
import type { ClaudeClient } from "../interpretation/claudeClient.js";

function fakeToolUseMessage(input: unknown): Anthropic.Message {
  return {
    content: [{ type: "tool_use", id: "tool_1", name: "classify_source", input }],
  } as unknown as Anthropic.Message;
}

function fakeTextOnlyMessage(): Anthropic.Message {
  return { content: [{ type: "text", text: "no tool call here" }] } as unknown as Anthropic.Message;
}

describe("isNoiseSource", () => {
  let lastParams: Anthropic.MessageCreateParamsNonStreaming | undefined;

  function stubClient(response: Anthropic.Message): ClaudeClient {
    return {
      createMessage: async (params) => {
        lastParams = params;
        return response;
      },
    };
  }

  afterEach(() => {
    lastParams = undefined;
  });

  it("calls the cheap Haiku model and forces the classify_source tool", async () => {
    const client = stubClient(fakeToolUseMessage({ isNoise: true, reason: "Out-of-office autoreply." }));

    await isNoiseSource({ subject: "Re: your message", from: "auto@vendor.com", body: "I am out of office." }, client);

    expect(lastParams?.model).toBe(NOISE_FILTER_MODEL);
    expect(lastParams?.tool_choice).toEqual({ type: "tool", name: "classify_source" });
  });

  it("returns isNoise=true with the model's reason for obvious noise", async () => {
    const client = stubClient(fakeToolUseMessage({ isNoise: true, reason: "Calendar decline notification." }));

    const result = await isNoiseSource(
      { subject: "Declined: Standup", from: "calendar-notifications@google.com", body: "" },
      client,
    );

    expect(result).toEqual({ isNoise: true, reason: "Calendar decline notification." });
  });

  it("returns isNoise=false for content with operational signal", async () => {
    const client = stubClient(
      fakeToolUseMessage({ isNoise: false, reason: "Reports a hardware issue needing follow-up." }),
    );

    const result = await isNoiseSource(
      { subject: "Rig #3 issue", from: "lab-tech@exvadebio.com", body: "Sensor dropout again today." },
      client,
    );

    expect(result.isNoise).toBe(false);
  });

  it("fails open (not noise) when the model doesn't call the tool", async () => {
    const client = stubClient(fakeTextOnlyMessage());

    const result = await isNoiseSource({ subject: "x", from: "y", body: "z" }, client);

    expect(result.isNoise).toBe(false);
  });

  it("fails open (not noise) when the tool call's input fails schema validation", async () => {
    const client = stubClient(fakeToolUseMessage({ isNoise: "yes", reason: 123 }));

    const result = await isNoiseSource({ subject: "x", from: "y", body: "z" }, client);

    expect(result.isNoise).toBe(false);
  });

  it("fails open when reason is missing entirely", async () => {
    const client = stubClient(fakeToolUseMessage({ isNoise: true }));

    const result = await isNoiseSource({ subject: "x", from: "y", body: "z" }, client);

    expect(result.isNoise).toBe(false);
  });
});
