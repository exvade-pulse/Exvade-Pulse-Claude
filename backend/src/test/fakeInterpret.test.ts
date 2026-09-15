import { describe, expect, it } from "vitest";
import { interpretFakeEmail } from "../interpretation/fakeInterpret.js";

describe("interpretFakeEmail", () => {
  it("proposes a new task under the given project with a reasoning string", () => {
    const draft = interpretFakeEmail(
      {
        subject: "Rig #3 sensor dropout",
        from: "lab-tech@exvadebio.com",
        body: "Details here.",
        receivedAt: new Date(),
      },
      { projectId: "11111111-1111-1111-1111-111111111111" },
    );

    expect(draft.targetType).toBe("task");
    expect(draft.targetId).toBeNull();
    expect(draft.changeType).toBe("new_task");
    expect(draft.proposedDiff.projectId).toBe("11111111-1111-1111-1111-111111111111");
    expect(draft.proposedDiff.title).toContain("Rig #3 sensor dropout");
    expect(draft.reasoning.length).toBeGreaterThan(0);
    expect(draft.confidence).toBeGreaterThan(0);
    expect(draft.confidence).toBeLessThanOrEqual(1);
  });
});
