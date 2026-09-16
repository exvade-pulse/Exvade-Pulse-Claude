import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { getClaudeClient, type ClaudeClient } from "./claudeClient.js";

// Sonnet, not Haiku, and deliberately the same model id/convention as
// interpret.ts: this is the one pre-pass where under-redacting a real patient
// detail is a compliance incident, not a quality nit, so accuracy wins over
// the marginal cost of the cheaper model.
export const REDACTION_MODEL = "claude-sonnet-5";

// Shown in place of a redacted span so the fact that something was removed
// stays visible/auditable, rather than silently vanishing from the sentence.
export const PATIENT_IDENTIFIER_PLACEHOLDER = "[PATIENT IDENTIFIER REDACTED]";

// Stored as sources.rawBody when redaction itself fails. Deliberately never
// the raw input -- see RedactionError callers for the fail-closed contract.
export const REDACTION_FAILURE_PLACEHOLDER_BODY =
  "[Content withheld: automatic redaction failed, needs manual review]";

export class RedactionError extends Error {}

const redactionResultSchema = z.object({
  redactedText: z.string(),
});

const REDACT_TOOL: Anthropic.Tool = {
  name: "redact_text",
  description:
    "Return the given text with patient-identifying details replaced by a placeholder, leaving everything else unchanged.",
  input_schema: {
    type: "object",
    properties: {
      redactedText: {
        type: "string",
        description:
          "The full input text, verbatim, except that every patient-identifying span has been replaced with the exact literal string \"[PATIENT IDENTIFIER REDACTED]\". Must preserve the surrounding sentence structure and all non-patient content unchanged, including whitespace/formatting outside redacted spans.",
      },
    },
    required: ["redactedText"],
  },
};

// This is an internal ops tool for a clinical-stage medical device company:
// most ingested content is legitimate operational/clinical/regulatory
// discussion that must survive untouched, and over-redacting it would make
// the tool useless. The prompt is written to bias toward that distinction
// explicitly rather than just toward "redact anything sensitive-sounding".
const SYSTEM_PROMPT = `You are a redaction pre-pass for Exvade Pulse, an internal ops tool for a clinical-stage medical device company. You are given one raw piece of ingested content (an email or meeting transcript) that is about to be stored and then fed to an AI interpretation pipeline. Your only job is to remove anything that would let a reader identify a specific patient, before any of that content is persisted or processed further.

Call the redact_text tool exactly once with the full text, verbatim, except that every patient-identifying span is replaced with the exact literal placeholder "${PATIENT_IDENTIFIER_PLACEHOLDER}".

Redact (replace with the placeholder):
- A specific patient's full name, or any partial name combined with other identifying context.
- Any patient ID, MRN, case number, or similar identifier.
- A patient's date of birth or other specific personal dates tied to them individually.
- Specific contact info (phone, email, physical address) when it belongs to a patient.
- Any other combination of specific, unusual details that would let someone identify a particular patient, even without a name -- e.g. "the 34-year-old patient from Duke with glioblastoma who enrolled in March" is identifying and must be redacted even though no name appears. When several specific details appear together about the same individual (age/location/diagnosis/enrollment date/etc.), redact the combination, not just one piece of it.

Do NOT redact:
- Employee or staff names (this is an internal tool; employee names like "Sean Meehan" or "Tejas" are essential operational content, not patient data).
- Company, vendor, hospital, or site names on their own.
- General clinical, regulatory, or business content: trial status, device specs, FDA correspondence, grant details, protocol details, timelines.
- Aggregate or non-identifying clinical facts: "the EFS cohort", "6 participants enrolled", "no device issues observed" -- these are operationally necessary and do not identify any one individual.

When in doubt about a specific span, weigh both failure modes: leaving in something that identifies a real patient is worse than a placeholder in a sentence that reads slightly awkwardly, but redacting ordinary business content makes this tool useless. Redact only what plausibly identifies a specific patient; leave everything else exactly as written, including formatting, whitespace, and structure.`;

// Fails CLOSED, the opposite of noiseFilter.ts's fail-open philosophy: this
// pre-pass exists specifically to keep unredacted patient content out of the
// database, so any failure to get a trustworthy result must never fall back
// to the raw text. Callers (pipeline.ts) are expected to catch RedactionError
// and substitute REDACTION_FAILURE_PLACEHOLDER_BODY instead of raw.body, and
// to stop before the noise filter / interpretation pass for that source.
export async function redactPatientIdentifiers(
  text: string,
  claudeClient: ClaudeClient = getClaudeClient(),
): Promise<string> {
  // Any failure here -- a network error, a rate limit, an SDK exception, not
  // just a malformed response -- must become a RedactionError, so callers
  // have exactly one failure type to catch for the fail-closed path.
  let response: Anthropic.Message;
  try {
    response = await claudeClient.createMessage({
      model: REDACTION_MODEL,
      // Output must be able to reproduce the entire input verbatim (minus
      // redacted spans), so this needs headroom well beyond a typical
      // structured-output call like interpret.ts's -- a long transcript is
      // the expected case here, not the exception.
      max_tokens: 8192,
      system: SYSTEM_PROMPT,
      tool_choice: { type: "tool", name: REDACT_TOOL.name },
      tools: [REDACT_TOOL],
      messages: [{ role: "user", content: text }],
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new RedactionError(`Redaction API call failed: ${message}`);
  }

  // A truncated tool call could silently cut off mid-span, potentially
  // reintroducing an unredacted fragment or corrupting content -- treat that
  // as untrustworthy rather than trusting a partial result.
  if (response.stop_reason === "max_tokens") {
    throw new RedactionError("Redaction response was truncated (max_tokens); refusing to trust a possibly incomplete result.");
  }

  const toolUse = response.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
  );
  if (!toolUse) {
    throw new RedactionError("Claude did not return a structured redaction result (no tool_use block in response).");
  }

  const parsed = redactionResultSchema.safeParse(toolUse.input);
  if (!parsed.success) {
    throw new RedactionError(`Redaction result failed schema validation: ${parsed.error.message}`);
  }

  return parsed.data.redactedText;
}
