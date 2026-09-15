import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { getClaudeClient, type ClaudeClient } from "./claudeClient.js";

// Cheap/fast model, deliberately pinned to this snapshot rather than a rolling
// alias -- this pre-pass runs on every ingested source, so its behavior should
// stay stable independent of what the interpretation pass (Sonnet) is using.
export const NOISE_FILTER_MODEL = "claude-haiku-4-5-20251001";

export interface NoiseCheckInput {
  subject: string;
  from: string;
  body: string;
}

export interface NoiseCheckResult {
  isNoise: boolean;
  reason: string;
}

const noiseResultSchema = z.object({
  isNoise: z.boolean(),
  reason: z.string().min(1),
});

const CLASSIFY_TOOL: Anthropic.Tool = {
  name: "classify_source",
  description:
    "Classify whether this raw communication is worth running the expensive, full interpretation pass on, or is obviously noise with no operational content -- e.g. an out-of-office autoreply, a calendar accept/decline, marketing/spam, or an automated notification.",
  input_schema: {
    type: "object",
    properties: {
      isNoise: {
        type: "boolean",
        description:
          "true if this is obviously noise and should be skipped. false if there is any plausible operational content worth the full pass -- when unsure, prefer false.",
      },
      reason: {
        type: "string",
        description: "One short sentence explaining the classification.",
      },
    },
    required: ["isNoise", "reason"],
  },
};

// Fail open on any unexpected shape from the model: never silently drop a
// source because the cheap classifier misbehaved. Worst case, an actually-noisy
// source proceeds to the (more expensive, more careful) interpretation pass.
const FAIL_OPEN_RESULT: NoiseCheckResult = {
  isNoise: false,
  reason: "Noise classifier did not return a usable result; defaulting to not-noise so nothing is silently dropped.",
};

export async function isNoiseSource(
  input: NoiseCheckInput,
  claudeClient: ClaudeClient = getClaudeClient(),
): Promise<NoiseCheckResult> {
  const response = await claudeClient.createMessage({
    model: NOISE_FILTER_MODEL,
    max_tokens: 256,
    tool_choice: { type: "tool", name: CLASSIFY_TOOL.name },
    tools: [CLASSIFY_TOOL],
    messages: [
      {
        role: "user",
        content: `Subject: ${input.subject}\nFrom: ${input.from}\n\n${input.body}`,
      },
    ],
  });

  const toolUse = response.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
  );
  if (!toolUse) {
    return FAIL_OPEN_RESULT;
  }

  const parsed = noiseResultSchema.safeParse(toolUse.input);
  if (!parsed.success) {
    return FAIL_OPEN_RESULT;
  }
  return parsed.data;
}
