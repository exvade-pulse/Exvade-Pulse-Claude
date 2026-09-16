import { afterEach, describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import {
  redactPatientIdentifiers,
  RedactionError,
  REDACTION_MODEL,
  PATIENT_IDENTIFIER_PLACEHOLDER,
} from "../interpretation/redactPatientIdentifiers.js";
import type { ClaudeClient } from "../interpretation/claudeClient.js";

function fakeToolUseMessage(input: unknown, stopReason: Anthropic.Message["stop_reason"] = "tool_use"): Anthropic.Message {
  return {
    content: [{ type: "tool_use", id: "tool_1", name: "redact_text", input }],
    stop_reason: stopReason,
  } as unknown as Anthropic.Message;
}

function fakeTextOnlyMessage(): Anthropic.Message {
  return { content: [{ type: "text", text: "no tool call here" }], stop_reason: "end_turn" } as unknown as Anthropic.Message;
}

describe("redactPatientIdentifiers", () => {
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

  it("calls Sonnet and forces the redact_text tool", async () => {
    const client = stubClient(fakeToolUseMessage({ redactedText: "hello" }));

    await redactPatientIdentifiers("hello", client);

    expect(lastParams?.model).toBe(REDACTION_MODEL);
    expect(lastParams?.tool_choice).toEqual({ type: "tool", name: "redact_text" });
  });

  it("redacts a patient name, DOB, and specific identifying clinical detail while preserving operational text and employee names", async () => {
    const redactedText = `Notes from Sean Meehan and Tejas: patient ${PATIENT_IDENTIFIER_PLACEHOLDER}, DOB ${PATIENT_IDENTIFIER_PLACEHOLDER}, is ${PATIENT_IDENTIFIER_PLACEHOLDER}. Next step: Tejas to draft the interview question list and route feedback to the clinical team by Friday.`;
    const client = stubClient(fakeToolUseMessage({ redactedText }));

    const result = await redactPatientIdentifiers(
      `Notes from Sean Meehan and Tejas: patient Jane Testperson, DOB 1/1/1990, is the 34-year-old glioblastoma patient from Duke who enrolled in March. Next step: Tejas to draft the interview question list and route feedback to the clinical team by Friday.`,
      client,
    );

    expect(result).toContain(PATIENT_IDENTIFIER_PLACEHOLDER);
    expect(result).toContain("Sean Meehan");
    expect(result).toContain("Tejas");
    expect(result).toContain("draft the interview question list");
    expect(result).not.toContain("Jane Testperson");
  });

  it("passes ordinary business/employee/clinical-aggregate content through unmodified", async () => {
    const body =
      "Sean and Tejas reviewed the EFS cohort status: 6 participants enrolled, no device issues observed. FDA correspondence is on track and the grant renewal is due next month.";
    const client = stubClient(fakeToolUseMessage({ redactedText: body }));

    const result = await redactPatientIdentifiers(body, client);

    expect(result).toBe(body);
    expect(result).not.toContain(PATIENT_IDENTIFIER_PLACEHOLDER);
  });

  it("throws RedactionError when the model doesn't call the tool", async () => {
    const client = stubClient(fakeTextOnlyMessage());

    await expect(redactPatientIdentifiers("some text", client)).rejects.toBeInstanceOf(RedactionError);
  });

  it("throws RedactionError when the tool input fails schema validation", async () => {
    const client = stubClient(fakeToolUseMessage({ notTheRightField: 123 }));

    await expect(redactPatientIdentifiers("some text", client)).rejects.toBeInstanceOf(RedactionError);
  });

  it("throws RedactionError when the response was truncated (max_tokens)", async () => {
    const client = stubClient(fakeToolUseMessage({ redactedText: "partial..." }, "max_tokens"));

    await expect(redactPatientIdentifiers("some long text", client)).rejects.toBeInstanceOf(RedactionError);
  });

  it("throws RedactionError (not the raw underlying error) when the API call itself throws", async () => {
    const client: ClaudeClient = {
      createMessage: async () => {
        throw new Error("simulated network failure");
      },
    };

    await expect(redactPatientIdentifiers("some text", client)).rejects.toBeInstanceOf(RedactionError);
  });
});
