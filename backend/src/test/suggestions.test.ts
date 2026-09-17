import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { testDb, truncateAll } from "./helpers.js";
import { createFixtureOrg } from "./fixtures.js";
import { auditLog, decisions, initiatives, objectives, projects, suggestions, tasks } from "../db/schema.js";
import { approveSuggestion, editSuggestion, rejectSuggestion, SuggestionApplyError } from "../suggestions/apply.js";
import { createDecision, DecisionError } from "../decisions/manage.js";
import { buildApp } from "../app.js";
import { signSession, SESSION_COOKIE_NAME } from "../auth/jwt.js";

const { db, client } = testDb();

afterAll(async () => {
  await client.end();
});

async function tokenFor(fixture: Awaited<ReturnType<typeof createFixtureOrg>>) {
  return signSession({
    userId: fixture.user.id,
    organizationId: fixture.org.id,
    email: fixture.user.email,
    role: fixture.authorization.role,
  });
}

describe("suggestion approval", () => {
  beforeEach(async () => {
    await truncateAll(db);
  });

  it("approving a new_task suggestion creates the task and writes an audit_log entry", async () => {
    const fixture = await createFixtureOrg(db, { domain: "approve-flow.test" });

    const [suggestion] = await db
      .insert(suggestions)
      .values({
        organizationId: fixture.org.id,
        sourceId: fixture.source.id,
        targetType: "task",
        targetId: null,
        changeType: "new_task",
        proposedDiff: {
          projectId: fixture.project.id,
          title: "Check wiring harness on rig #3",
          nextAction: "Inspect wiring before next run",
        },
        reasoning: "No existing open task matches this report.",
        confidence: 0.6,
      })
      .returning();

    const updated = await approveSuggestion(db, {
      organizationId: fixture.org.id,
      suggestionId: suggestion.id,
      reviewerId: fixture.user.id,
    });

    expect(updated.status).toBe("approved");
    expect(updated.reviewedBy).toBe(fixture.user.id);
    expect(updated.targetId).not.toBeNull();

    const [task] = await db.select().from(tasks).where(eq(tasks.id, updated.targetId!));
    expect(task).toBeDefined();
    expect(task.title).toBe("Check wiring harness on rig #3");
    expect(task.projectId).toBe(fixture.project.id);
    expect(task.status).toBe("active");

    const auditRows = await db.select().from(auditLog).where(eq(auditLog.entityId, task.id));
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0].action).toBe("suggestion.approved");
    expect(auditRows[0].actorId).toBe(fixture.user.id);
  });

  it("approving an update suggestion (targetId set) mutates the existing task, not a new one", async () => {
    const fixture = await createFixtureOrg(db, { domain: "update-flow.test" });

    const [existingTask] = await db
      .insert(tasks)
      .values({
        organizationId: fixture.org.id,
        projectId: fixture.project.id,
        title: "Original title",
        status: "active",
      })
      .returning();

    const [suggestion] = await db
      .insert(suggestions)
      .values({
        organizationId: fixture.org.id,
        sourceId: fixture.source.id,
        targetType: "task",
        targetId: existingTask.id,
        changeType: "operational_update",
        proposedDiff: { status: "blocked", latestUpdate: "Waiting on part shipment." },
        reasoning: "Email reports a blocker on this exact task.",
        confidence: 0.8,
      })
      .returning();

    const updated = await approveSuggestion(db, {
      organizationId: fixture.org.id,
      suggestionId: suggestion.id,
      reviewerId: fixture.user.id,
    });

    expect(updated.targetId).toBe(existingTask.id);

    const [task] = await db.select().from(tasks).where(eq(tasks.id, existingTask.id));
    expect(task.status).toBe("blocked");
    expect(task.latestUpdate).toBe("Waiting on part shipment.");
    expect(task.title).toBe("Original title"); // untouched field stays as-is

    const allTasks = await db.select().from(tasks).where(eq(tasks.organizationId, fixture.org.id));
    expect(allTasks).toHaveLength(1); // no new task was created
  });

  it("approving a context suggestion on a task sets description/owner but silently drops status/latestUpdate/nextAction, even if the AI included them", async () => {
    const fixture = await createFixtureOrg(db, { domain: "context-field-gate.test" });

    const [existingTask] = await db
      .insert(tasks)
      .values({
        organizationId: fixture.org.id,
        projectId: fixture.project.id,
        title: "Original title",
        status: "active",
        latestUpdate: "Original latest update",
      })
      .returning();

    const [suggestion] = await db
      .insert(suggestions)
      .values({
        organizationId: fixture.org.id,
        sourceId: fixture.source.id,
        targetType: "task",
        targetId: existingTask.id,
        changeType: "context",
        // A context suggestion should never legally carry these current-state
        // fields, but this proves they're stripped even if the AI (or a
        // hand-edit) put them there -- the enforcement must not just be a
        // prompt convention.
        proposedDiff: {
          description: "Background: this stalled because of a vendor delay, not a design issue.",
          owner: "Sean Meehan",
          status: "blocked",
          latestUpdate: "This should never be applied",
          nextAction: "This should never be applied either",
        },
        reasoning: "Email adds background color, not a state change.",
        confidence: 0.7,
      })
      .returning();

    await approveSuggestion(db, {
      organizationId: fixture.org.id,
      suggestionId: suggestion.id,
      reviewerId: fixture.user.id,
    });

    const [task] = await db.select().from(tasks).where(eq(tasks.id, existingTask.id));
    expect(task.description).toBe("Background: this stalled because of a vendor delay, not a design issue.");
    expect(task.owner).toBe("Sean Meehan");
    expect(task.status).toBe("active"); // untouched -- context can't change current state
    expect(task.latestUpdate).toBe("Original latest update"); // untouched
    expect(task.nextAction).toBeNull(); // untouched
  });

  it("editSuggestion re-applies the same context restriction, so a hand-edit can't add current-state fields to a context suggestion", async () => {
    const fixture = await createFixtureOrg(db, { domain: "context-field-gate-edit.test" });

    const [existingTask] = await db
      .insert(tasks)
      .values({ organizationId: fixture.org.id, projectId: fixture.project.id, title: "Task", status: "active" })
      .returning();

    const [suggestion] = await db
      .insert(suggestions)
      .values({
        organizationId: fixture.org.id,
        sourceId: fixture.source.id,
        targetType: "task",
        targetId: existingTask.id,
        changeType: "context",
        proposedDiff: { description: "Some background." },
        reasoning: "test",
        confidence: 0.7,
      })
      .returning();

    const edited = await editSuggestion(db, {
      organizationId: fixture.org.id,
      suggestionId: suggestion.id,
      actorId: fixture.user.id,
      diff: { status: "blocked", latestUpdate: "Trying to sneak this in" },
    });

    expect(edited.proposedDiff).not.toHaveProperty("status");
    expect(edited.proposedDiff).not.toHaveProperty("latestUpdate");
    expect(edited.proposedDiff).toMatchObject({ description: "Some background." });
  });

  it("an operational_update suggestion is unaffected by the context restriction and can still set status/latestUpdate", async () => {
    const fixture = await createFixtureOrg(db, { domain: "operational-update-unaffected.test" });

    const [existingTask] = await db
      .insert(tasks)
      .values({ organizationId: fixture.org.id, projectId: fixture.project.id, title: "Task", status: "active" })
      .returning();

    const [suggestion] = await db
      .insert(suggestions)
      .values({
        organizationId: fixture.org.id,
        sourceId: fixture.source.id,
        targetType: "task",
        targetId: existingTask.id,
        changeType: "operational_update",
        proposedDiff: { status: "blocked", latestUpdate: "Genuinely blocked now" },
        reasoning: "test",
        confidence: 0.8,
      })
      .returning();

    await approveSuggestion(db, {
      organizationId: fixture.org.id,
      suggestionId: suggestion.id,
      reviewerId: fixture.user.id,
    });

    const [task] = await db.select().from(tasks).where(eq(tasks.id, existingTask.id));
    expect(task.status).toBe("blocked");
    expect(task.latestUpdate).toBe("Genuinely blocked now");
  });

  it("rejecting a suggestion marks it rejected and never touches the target tables", async () => {
    const fixture = await createFixtureOrg(db, { domain: "reject-flow.test" });

    const [suggestion] = await db
      .insert(suggestions)
      .values({
        organizationId: fixture.org.id,
        sourceId: fixture.source.id,
        targetType: "task",
        targetId: null,
        changeType: "new_task",
        proposedDiff: { projectId: fixture.project.id, title: "Should never be created" },
        reasoning: "test",
        confidence: 0.3,
      })
      .returning();

    const updated = await rejectSuggestion(db, {
      organizationId: fixture.org.id,
      suggestionId: suggestion.id,
      reviewerId: fixture.user.id,
    });

    expect(updated.status).toBe("rejected");

    const allTasks = await db.select().from(tasks).where(eq(tasks.organizationId, fixture.org.id));
    expect(allTasks).toHaveLength(0);
  });

  it("cannot approve an already-approved suggestion again", async () => {
    const fixture = await createFixtureOrg(db, { domain: "double-approve.test" });

    const [suggestion] = await db
      .insert(suggestions)
      .values({
        organizationId: fixture.org.id,
        sourceId: fixture.source.id,
        targetType: "task",
        targetId: null,
        changeType: "new_task",
        proposedDiff: { projectId: fixture.project.id, title: "Once" },
        reasoning: "test",
        confidence: 0.5,
      })
      .returning();

    await approveSuggestion(db, {
      organizationId: fixture.org.id,
      suggestionId: suggestion.id,
      reviewerId: fixture.user.id,
    });

    await expect(
      approveSuggestion(db, {
        organizationId: fixture.org.id,
        suggestionId: suggestion.id,
        reviewerId: fixture.user.id,
      }),
    ).rejects.toBeInstanceOf(SuggestionApplyError);
  });

  it("approving a decision-type suggestion calls createDecision instead of the generic insert path, backfills targetId, and writes decision.created exactly once", async () => {
    const fixture = await createFixtureOrg(db, { domain: "decision-suggestion.test" });

    const [suggestion] = await db
      .insert(suggestions)
      .values({
        organizationId: fixture.org.id,
        sourceId: fixture.source.id,
        targetType: "decision",
        targetId: null,
        changeType: "decision",
        proposedDiff: {
          title: "Should we renegotiate the sensor vendor contract?",
          decider: "Leadership",
          stakeholders: ["Ops lead", "CFO"],
          whyItMatters: "Current vendor's lead time threatens the trial timeline.",
        },
        reasoning: "Source describes an open question needing a leadership call.",
        confidence: 0.75,
      })
      .returning();

    const updated = await approveSuggestion(db, {
      organizationId: fixture.org.id,
      suggestionId: suggestion.id,
      reviewerId: fixture.user.id,
    });

    expect(updated.status).toBe("approved");
    expect(updated.targetId).not.toBeNull();

    const [decision] = await db.select().from(decisions).where(eq(decisions.id, updated.targetId!));
    expect(decision).toBeDefined();
    expect(decision.title).toBe("Should we renegotiate the sensor vendor contract?");
    expect(decision.decider).toBe("Leadership");
    expect(decision.stakeholders).toEqual(["Ops lead", "CFO"]);
    expect(decision.status).toBe("open");
    // Cited from the suggestion's own sourceId, not something the model has to propose.
    expect(decision.sourceId).toBe(fixture.source.id);

    const auditRows = await db.select().from(auditLog).where(eq(auditLog.entityId, decision.id));
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0].action).toBe("decision.created");
    expect(auditRows[0].actorId).toBe(fixture.user.id);

    // No task/objective/etc. row should have been created via the generic path.
    const allTasks = await db.select().from(tasks).where(eq(tasks.organizationId, fixture.org.id));
    expect(allTasks).toHaveLength(0);
  });

  it("approving a decision-update suggestion (targetId set) updates only the whitelisted fields, writes decision.updated, and creates no second decision", async () => {
    const fixture = await createFixtureOrg(db, { domain: "decision-update-flow.test" });

    const existingDecision = await createDecision(db, {
      organizationId: fixture.org.id,
      actorId: fixture.user.id,
      title: "What should the fractional CFO engagement's scope be going forward?",
      decider: "Leadership",
      stakeholders: ["Finance"],
      whyItMatters: "Engagement expires end of quarter with no successor plan.",
    });

    const [suggestion] = await db
      .insert(suggestions)
      .values({
        organizationId: fixture.org.id,
        sourceId: fixture.source.id,
        targetType: "decision",
        targetId: existingDecision.id,
        changeType: "decision",
        proposedDiff: {
          relevantContext: "Leadership discussed this in Monday's meeting but hasn't decided.",
          suggestedNextStep: "Get a written answer from the CEO by Friday.",
        },
        reasoning: "Follow-up on the already-open CFO scope decision, not a new one.",
        confidence: 0.75,
      })
      .returning();

    const updated = await approveSuggestion(db, {
      organizationId: fixture.org.id,
      suggestionId: suggestion.id,
      reviewerId: fixture.user.id,
    });

    expect(updated.status).toBe("approved");
    expect(updated.targetId).toBe(existingDecision.id);

    const [decision] = await db.select().from(decisions).where(eq(decisions.id, existingDecision.id));
    expect(decision.relevantContext).toBe("Leadership discussed this in Monday's meeting but hasn't decided.");
    expect(decision.suggestedNextStep).toBe("Get a written answer from the CEO by Friday.");
    // Fields not present in this diff must stay untouched.
    expect(decision.decider).toBe("Leadership");
    expect(decision.stakeholders).toEqual(["Finance"]);
    expect(decision.title).toBe("What should the fractional CFO engagement's scope be going forward?");

    const auditRows = await db.select().from(auditLog).where(eq(auditLog.entityId, existingDecision.id));
    const updateLog = auditRows.find((row) => row.action === "decision.updated");
    expect(updateLog).toBeDefined();
    expect(updateLog?.actorId).toBe(fixture.user.id);
    expect(auditRows.some((row) => row.action === "decision.created")).toBe(true);
    expect(auditRows.filter((row) => row.action === "suggestion.approved")).toHaveLength(0);

    const allDecisions = await db.select().from(decisions).where(eq(decisions.organizationId, fixture.org.id));
    expect(allDecisions).toHaveLength(1); // no second decision created
  });

  it("cannot approve a decision-update suggestion against a decision belonging to a different organization", async () => {
    const orgA = await createFixtureOrg(db, { domain: "decision-update-org-a.test" });
    const orgB = await createFixtureOrg(db, { domain: "decision-update-org-b.test" });

    const decisionB = await createDecision(db, {
      organizationId: orgB.org.id,
      actorId: orgB.user.id,
      title: "Belongs to org B",
      decider: "CEO",
    });

    const [suggestion] = await db
      .insert(suggestions)
      .values({
        organizationId: orgA.org.id,
        sourceId: orgA.source.id,
        targetType: "decision",
        targetId: decisionB.id, // cross-org targetId, as if tampered or mismatched
        changeType: "decision",
        proposedDiff: { relevantContext: "Attempted cross-org update." },
        reasoning: "test",
        confidence: 0.6,
      })
      .returning();

    await expect(
      approveSuggestion(db, {
        organizationId: orgA.org.id,
        suggestionId: suggestion.id,
        reviewerId: orgA.user.id,
      }),
    ).rejects.toBeInstanceOf(DecisionError);

    const [decisionRow] = await db.select().from(decisions).where(eq(decisions.id, decisionB.id));
    expect(decisionRow.relevantContext).toBeNull();
  });

  it("approving a suggestion with owner in proposedDiff sets it, for each of the four hierarchy target types", async () => {
    const fixture = await createFixtureOrg(db, { domain: "owner-flow.test" });

    const cases: Array<{
      targetType: "objective" | "initiative" | "project" | "task";
      proposedDiff: Record<string, unknown>;
      table: typeof objectives | typeof initiatives | typeof projects | typeof tasks;
    }> = [
      { targetType: "objective", proposedDiff: { title: "New objective", owner: "Sean Meehan" }, table: objectives },
      {
        targetType: "initiative",
        proposedDiff: { objectiveId: fixture.objective.id, title: "New initiative", owner: "Sean Meehan" },
        table: initiatives,
      },
      {
        targetType: "project",
        proposedDiff: { initiativeId: fixture.initiative.id, title: "New project", owner: "Sean Meehan" },
        table: projects,
      },
      {
        targetType: "task",
        proposedDiff: { projectId: fixture.project.id, title: "New task", owner: "Sean Meehan" },
        table: tasks,
      },
    ];

    for (const { targetType, proposedDiff, table } of cases) {
      const [suggestion] = await db
        .insert(suggestions)
        .values({
          organizationId: fixture.org.id,
          sourceId: fixture.source.id,
          targetType,
          targetId: null,
          // new_task (not context): context suggestions are restricted to
          // description/owner and can never create a new row (see the
          // context-field-gate tests above) -- this test is about owner
          // pass-through on creation, unrelated to context semantics.
          changeType: "new_task",
          proposedDiff,
          reasoning: "test",
          confidence: 0.5,
        })
        .returning();

      const updated = await approveSuggestion(db, {
        organizationId: fixture.org.id,
        suggestionId: suggestion.id,
        reviewerId: fixture.user.id,
      });

      const [row] = await db.select().from(table).where(eq(table.id, updated.targetId!));
      expect((row as { owner: string | null }).owner).toBe("Sean Meehan");
    }
  });

  it("strips an owner key from a decision suggestion's proposedDiff -- owner is only whitelisted for the four hierarchy types", async () => {
    const fixture = await createFixtureOrg(db, { domain: "decision-owner-scope.test" });

    const [suggestion] = await db
      .insert(suggestions)
      .values({
        organizationId: fixture.org.id,
        sourceId: fixture.source.id,
        targetType: "decision",
        targetId: null,
        changeType: "decision",
        proposedDiff: {
          title: "Should we renew the office lease?",
          decider: "Leadership",
          owner: "Sean Meehan", // not a decision field -- must be dropped, not smuggled onto the decision
        },
        reasoning: "test",
        confidence: 0.6,
      })
      .returning();

    const updated = await approveSuggestion(db, {
      organizationId: fixture.org.id,
      suggestionId: suggestion.id,
      reviewerId: fixture.user.id,
    });

    const [decision] = await db.select().from(decisions).where(eq(decisions.id, updated.targetId!));
    expect(decision).toBeDefined();
    expect(decision).not.toHaveProperty("owner");
  });
});

describe("suggestion editing", () => {
  beforeEach(async () => {
    await truncateAll(db);
  });

  it("editing a pending suggestion merges into proposedDiff, sets status to edited, and writes an audit_log entry", async () => {
    const fixture = await createFixtureOrg(db, { domain: "edit-flow.test" });

    const [suggestion] = await db
      .insert(suggestions)
      .values({
        organizationId: fixture.org.id,
        sourceId: fixture.source.id,
        targetType: "task",
        targetId: null,
        changeType: "new_task",
        proposedDiff: {
          projectId: fixture.project.id,
          title: "Check wiring harness on rig #3",
          nextAction: "Inspect wiring before next run",
        },
        reasoning: "No existing open task matches this report.",
        confidence: 0.6,
      })
      .returning();

    const updated = await editSuggestion(db, {
      organizationId: fixture.org.id,
      suggestionId: suggestion.id,
      actorId: fixture.user.id,
      diff: { nextAction: "Corrected: inspect wiring and connectors before next run" },
    });

    expect(updated.status).toBe("edited");
    expect(updated.proposedDiff).toMatchObject({
      projectId: fixture.project.id,
      title: "Check wiring harness on rig #3",
      nextAction: "Corrected: inspect wiring and connectors before next run",
    });

    const auditRows = await db.select().from(auditLog).where(eq(auditLog.action, "suggestion.edited"));
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0].actorId).toBe(fixture.user.id);
    expect((auditRows[0].details as Record<string, unknown>).suggestionId).toBe(suggestion.id);
  });

  it("drops a field outside the target type's whitelist from the edit, same as apply.ts does for the AI's own output", async () => {
    const fixture = await createFixtureOrg(db, { domain: "edit-whitelist.test" });

    const [suggestion] = await db
      .insert(suggestions)
      .values({
        organizationId: fixture.org.id,
        sourceId: fixture.source.id,
        targetType: "task",
        targetId: null,
        changeType: "new_task",
        proposedDiff: { projectId: fixture.project.id, title: "Original title" },
        reasoning: "test",
        confidence: 0.5,
      })
      .returning();

    const updated = await editSuggestion(db, {
      organizationId: fixture.org.id,
      suggestionId: suggestion.id,
      actorId: fixture.user.id,
      diff: { title: "Edited title", organizationId: "should-not-appear", notAField: "nope" },
    });

    expect(updated.proposedDiff).toMatchObject({ title: "Edited title" });
    expect(updated.proposedDiff).not.toHaveProperty("organizationId");
    expect(updated.proposedDiff).not.toHaveProperty("notAField");
  });

  it("cannot edit an already-approved or already-rejected suggestion", async () => {
    const fixture = await createFixtureOrg(db, { domain: "edit-terminal.test" });

    const [approved] = await db
      .insert(suggestions)
      .values({
        organizationId: fixture.org.id,
        sourceId: fixture.source.id,
        targetType: "task",
        targetId: null,
        changeType: "new_task",
        proposedDiff: { projectId: fixture.project.id, title: "Once" },
        reasoning: "test",
        confidence: 0.5,
      })
      .returning();

    await approveSuggestion(db, {
      organizationId: fixture.org.id,
      suggestionId: approved.id,
      reviewerId: fixture.user.id,
    });

    await expect(
      editSuggestion(db, {
        organizationId: fixture.org.id,
        suggestionId: approved.id,
        actorId: fixture.user.id,
        diff: { title: "Too late" },
      }),
    ).rejects.toBeInstanceOf(SuggestionApplyError);

    const [rejected] = await db
      .insert(suggestions)
      .values({
        organizationId: fixture.org.id,
        sourceId: fixture.source.id,
        targetType: "task",
        targetId: null,
        changeType: "new_task",
        proposedDiff: { projectId: fixture.project.id, title: "Also once" },
        reasoning: "test",
        confidence: 0.5,
      })
      .returning();

    await rejectSuggestion(db, {
      organizationId: fixture.org.id,
      suggestionId: rejected.id,
      reviewerId: fixture.user.id,
    });

    await expect(
      editSuggestion(db, {
        organizationId: fixture.org.id,
        suggestionId: rejected.id,
        actorId: fixture.user.id,
        diff: { title: "Too late again" },
      }),
    ).rejects.toBeInstanceOf(SuggestionApplyError);
  });

  it("approving a previously-edited suggestion applies the edited diff, not the original", async () => {
    const fixture = await createFixtureOrg(db, { domain: "edit-then-approve.test" });

    const [suggestion] = await db
      .insert(suggestions)
      .values({
        organizationId: fixture.org.id,
        sourceId: fixture.source.id,
        targetType: "task",
        targetId: null,
        changeType: "new_task",
        proposedDiff: { projectId: fixture.project.id, title: "Original title", nextAction: "Original action" },
        reasoning: "test",
        confidence: 0.5,
      })
      .returning();

    await editSuggestion(db, {
      organizationId: fixture.org.id,
      suggestionId: suggestion.id,
      actorId: fixture.user.id,
      diff: { title: "Edited title" },
    });

    const approved = await approveSuggestion(db, {
      organizationId: fixture.org.id,
      suggestionId: suggestion.id,
      reviewerId: fixture.user.id,
    });

    expect(approved.status).toBe("approved");

    const [task] = await db.select().from(tasks).where(eq(tasks.id, approved.targetId!));
    expect(task.title).toBe("Edited title");
    expect(task.nextAction).toBe("Original action");
  });
});

describe("GET /api/suggestions currentState", () => {
  beforeEach(async () => {
    await truncateAll(db);
  });

  it("includes only the fields the diff actually touches, pulled from the live target row", async () => {
    const fixture = await createFixtureOrg(db, { domain: "current-state-update.test" });

    const [existingTask] = await db
      .insert(tasks)
      .values({
        organizationId: fixture.org.id,
        projectId: fixture.project.id,
        title: "Original title",
        status: "active",
        latestUpdate: "Original latest update",
        owner: "Someone else",
      })
      .returning();

    await db.insert(suggestions).values({
      organizationId: fixture.org.id,
      sourceId: fixture.source.id,
      targetType: "task",
      targetId: existingTask.id,
      changeType: "operational_update",
      proposedDiff: { status: "blocked", latestUpdate: "New update text" },
      reasoning: "test",
      confidence: 0.8,
    });

    const app = await buildApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/suggestions",
      cookies: { [SESSION_COOKIE_NAME]: await tokenFor(fixture) },
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    const body = response.json() as { suggestions: Array<{ currentState: Record<string, unknown> | null }> };
    expect(body.suggestions).toHaveLength(1);
    // Only status/latestUpdate -- title/owner aren't in the diff, so they
    // must not leak into currentState even though they exist on the row.
    expect(body.suggestions[0].currentState).toEqual({
      status: "active",
      latestUpdate: "Original latest update",
    });
  });

  it("is null for a suggestion proposing a brand-new entity (targetId null)", async () => {
    const fixture = await createFixtureOrg(db, { domain: "current-state-new.test" });

    await db.insert(suggestions).values({
      organizationId: fixture.org.id,
      sourceId: fixture.source.id,
      targetType: "task",
      targetId: null,
      changeType: "new_task",
      proposedDiff: { projectId: fixture.project.id, title: "Brand new task" },
      reasoning: "test",
      confidence: 0.6,
    });

    const app = await buildApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/suggestions",
      cookies: { [SESSION_COOKIE_NAME]: await tokenFor(fixture) },
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    const body = response.json() as { suggestions: Array<{ currentState: unknown }> };
    expect(body.suggestions[0].currentState).toBeNull();
  });

  it("works for a decision target, reflecting the decision's own current fields", async () => {
    const fixture = await createFixtureOrg(db, { domain: "current-state-decision.test" });

    const decision = await createDecision(db, {
      organizationId: fixture.org.id,
      actorId: fixture.user.id,
      title: "Approve vendor switch",
      decider: "CEO",
      relevantContext: "Original context.",
    });

    await db.insert(suggestions).values({
      organizationId: fixture.org.id,
      sourceId: fixture.source.id,
      targetType: "decision",
      targetId: decision.id,
      changeType: "context",
      proposedDiff: { relevantContext: "Updated context from a follow-up email." },
      reasoning: "test",
      confidence: 0.7,
    });

    const app = await buildApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/suggestions",
      cookies: { [SESSION_COOKIE_NAME]: await tokenFor(fixture) },
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    const body = response.json() as { suggestions: Array<{ currentState: Record<string, unknown> | null }> };
    expect(body.suggestions[0].currentState).toEqual({ relevantContext: "Original context." });
  });

  it("never leaks another organization's current-state data", async () => {
    const orgA = await createFixtureOrg(db, { domain: "current-state-org-a.test" });
    const orgB = await createFixtureOrg(db, { domain: "current-state-org-b.test" });

    const [taskB] = await db
      .insert(tasks)
      .values({ organizationId: orgB.org.id, projectId: orgB.project.id, title: "Org B task", status: "active" })
      .returning();

    // A suggestion in org A's own queue, but pointed (however implausibly)
    // at a task id that happens to belong to org B -- loadCurrentStates must
    // still org-scope the lookup rather than trusting targetId alone.
    await db.insert(suggestions).values({
      organizationId: orgA.org.id,
      sourceId: orgA.source.id,
      targetType: "task",
      targetId: taskB.id,
      changeType: "operational_update",
      proposedDiff: { status: "blocked" },
      reasoning: "test",
      confidence: 0.5,
    });

    const app = await buildApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/suggestions",
      cookies: { [SESSION_COOKIE_NAME]: await tokenFor(orgA) },
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    const body = response.json() as { suggestions: Array<{ currentState: unknown }> };
    expect(body.suggestions[0].currentState).toBeNull();
  });
});
