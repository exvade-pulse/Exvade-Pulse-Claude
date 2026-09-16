export interface FakeEmail {
  subject: string;
  from: string;
  body: string;
  receivedAt: Date;
}

export interface SuggestionDraft {
  changeType: "operational_update" | "context" | "new_task" | "decision" | "deadline" | "resolved";
  targetType: "objective" | "initiative" | "project" | "task" | "decision";
  targetId: string | null;
  proposedDiff: Record<string, unknown>;
  reasoning: string;
  confidence: number;
}

// Placeholder for the real Claude-driven interpretation pipeline. Takes one
// "email" and always proposes the same new task under the given project, so the
// suggestions -> review -> approve path can be exercised end-to-end before any
// real matching/dedup logic exists. Pure function: no DB access, easy to unit test
// and to swap out later behind the same signature.
export function interpretFakeEmail(email: FakeEmail, context: { projectId: string }): SuggestionDraft {
  return {
    changeType: "new_task",
    targetType: "task",
    targetId: null,
    proposedDiff: {
      projectId: context.projectId,
      title: `Follow up: ${email.subject}`,
      description: email.body,
      status: "active",
      nextAction: "Triage this new item and confirm ownership.",
    },
    reasoning: `Email from ${email.from} with subject "${email.subject}" doesn't match any existing open task, so a new task is proposed rather than silently dropped.`,
    confidence: 0.55,
  };
}
