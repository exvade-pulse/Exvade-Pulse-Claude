import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { testDb, truncateAll } from "./helpers.js";
import { createFixtureOrg } from "./fixtures.js";
import { auditLog, decisions, initiatives, objectives, projects, sources, suggestions, tasks } from "../db/schema.js";
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

describe("approveSuggestion fieldEvidence", () => {
  beforeEach(async () => {
    await truncateAll(db);
  });

  it("records asOf/sourceId for exactly the tracked fields the diff touches", async () => {
    const fixture = await createFixtureOrg(db, { domain: "field-evidence-basic.test" });
    const receivedAt = new Date("2026-08-01T12:00:00.000Z");
    const [source] = await db
      .insert(sources)
      .values({ organizationId: fixture.org.id, type: "gmail", externalId: "ext-evidence-basic", receivedAt })
      .returning();

    const [existingTask] = await db
      .insert(tasks)
      .values({ organizationId: fixture.org.id, projectId: fixture.project.id, title: "Task", status: "active" })
      .returning();

    const [suggestion] = await db
      .insert(suggestions)
      .values({
        organizationId: fixture.org.id,
        sourceId: source.id,
        targetType: "task",
        targetId: existingTask.id,
        changeType: "operational_update",
        proposedDiff: { status: "blocked", latestUpdate: "Waiting on part shipment." },
        reasoning: "test",
        confidence: 0.8,
      })
      .returning();

    await approveSuggestion(db, { organizationId: fixture.org.id, suggestionId: suggestion.id, reviewerId: fixture.user.id });

    const [task] = await db.select().from(tasks).where(eq(tasks.id, existingTask.id));
    const evidence = task.fieldEvidence as Record<string, { asOf: string; sourceId: string }>;
    expect(evidence.status).toEqual({ asOf: receivedAt.toISOString(), sourceId: source.id });
    expect(evidence.latestUpdate).toEqual({ asOf: receivedAt.toISOString(), sourceId: source.id });
    // nextAction/owner weren't in this diff -- no evidence entry for them.
    expect(evidence.nextAction).toBeUndefined();
    expect(evidence.owner).toBeUndefined();
  });

  it("leaves existing evidence for other fields untouched (shallow merge, not overwrite)", async () => {
    const fixture = await createFixtureOrg(db, { domain: "field-evidence-shallow-merge.test" });
    const firstReceivedAt = new Date("2026-07-01T00:00:00.000Z");
    const secondReceivedAt = new Date("2026-08-01T00:00:00.000Z");
    const [firstSource] = await db
      .insert(sources)
      .values({ organizationId: fixture.org.id, type: "gmail", externalId: "ext-evidence-first", receivedAt: firstReceivedAt })
      .returning();
    const [secondSource] = await db
      .insert(sources)
      .values({ organizationId: fixture.org.id, type: "gmail", externalId: "ext-evidence-second", receivedAt: secondReceivedAt })
      .returning();

    const [existingTask] = await db
      .insert(tasks)
      .values({ organizationId: fixture.org.id, projectId: fixture.project.id, title: "Task", status: "active" })
      .returning();

    const [firstSuggestion] = await db
      .insert(suggestions)
      .values({
        organizationId: fixture.org.id,
        sourceId: firstSource.id,
        targetType: "task",
        targetId: existingTask.id,
        changeType: "operational_update",
        proposedDiff: { owner: "Sean Meehan" },
        reasoning: "test",
        confidence: 0.7,
      })
      .returning();
    await approveSuggestion(db, { organizationId: fixture.org.id, suggestionId: firstSuggestion.id, reviewerId: fixture.user.id });

    const [secondSuggestion] = await db
      .insert(suggestions)
      .values({
        organizationId: fixture.org.id,
        sourceId: secondSource.id,
        targetType: "task",
        targetId: existingTask.id,
        changeType: "operational_update",
        proposedDiff: { status: "blocked" },
        reasoning: "test",
        confidence: 0.7,
      })
      .returning();
    await approveSuggestion(db, { organizationId: fixture.org.id, suggestionId: secondSuggestion.id, reviewerId: fixture.user.id });

    const [task] = await db.select().from(tasks).where(eq(tasks.id, existingTask.id));
    const evidence = task.fieldEvidence as Record<string, { asOf: string; sourceId: string }>;
    // owner's evidence from the first approval must survive the second
    // approval, which never touched owner.
    expect(evidence.owner).toEqual({ asOf: firstReceivedAt.toISOString(), sourceId: firstSource.id });
    expect(evidence.status).toEqual({ asOf: secondReceivedAt.toISOString(), sourceId: secondSource.id });
  });

  it("seeds fieldEvidence on a brand-new task from its own creating suggestion", async () => {
    const fixture = await createFixtureOrg(db, { domain: "field-evidence-new-task.test" });
    const receivedAt = new Date("2026-08-15T00:00:00.000Z");
    const [source] = await db
      .insert(sources)
      .values({ organizationId: fixture.org.id, type: "gmail", externalId: "ext-evidence-new-task", receivedAt })
      .returning();

    const [suggestion] = await db
      .insert(suggestions)
      .values({
        organizationId: fixture.org.id,
        sourceId: source.id,
        targetType: "task",
        targetId: null,
        changeType: "new_task",
        proposedDiff: { projectId: fixture.project.id, title: "New task", status: "active", nextAction: "Kick off" },
        reasoning: "test",
        confidence: 0.6,
      })
      .returning();

    const updated = await approveSuggestion(db, { organizationId: fixture.org.id, suggestionId: suggestion.id, reviewerId: fixture.user.id });

    const [task] = await db.select().from(tasks).where(eq(tasks.id, updated.targetId!));
    const evidence = task.fieldEvidence as Record<string, { asOf: string; sourceId: string }>;
    expect(evidence.status).toEqual({ asOf: receivedAt.toISOString(), sourceId: source.id });
    expect(evidence.nextAction).toEqual({ asOf: receivedAt.toISOString(), sourceId: source.id });
  });

  it("never writes fieldEvidence for a non-task target type", async () => {
    const fixture = await createFixtureOrg(db, { domain: "field-evidence-non-task.test" });

    const [suggestion] = await db
      .insert(suggestions)
      .values({
        organizationId: fixture.org.id,
        sourceId: fixture.source.id,
        targetType: "project",
        targetId: fixture.project.id,
        changeType: "operational_update",
        proposedDiff: { status: "paused" },
        reasoning: "test",
        confidence: 0.6,
      })
      .returning();

    await approveSuggestion(db, { organizationId: fixture.org.id, suggestionId: suggestion.id, reviewerId: fixture.user.id });

    const [project] = await db.select().from(projects).where(eq(projects.id, fixture.project.id));
    expect(project).not.toHaveProperty("fieldEvidence");
  });
});

describe("approveSuggestion rejects a malformed new-entity diff instead of crashing", () => {
  beforeEach(async () => {
    await truncateAll(db);
  });

  // Real production bug: a new_task-labeled suggestion proposing a brand-new
  // PROJECT whose proposedDiff never included initiativeId reached the
  // database uncaught, where the NOT NULL constraint threw a raw Postgres
  // error -- crashing the whole request instead of failing gracefully.
  it("throws SuggestionApplyError (not a raw DB error) when a new project's proposedDiff is missing initiativeId", async () => {
    const fixture = await createFixtureOrg(db, { domain: "missing-required-field-project.test" });

    const [suggestion] = await db
      .insert(suggestions)
      .values({
        organizationId: fixture.org.id,
        sourceId: fixture.source.id,
        targetType: "project",
        targetId: null,
        changeType: "new_task",
        proposedDiff: { title: "A project with no initiative", description: "Missing initiativeId entirely." },
        reasoning: "test",
        confidence: 0.6,
      })
      .returning();

    await expect(
      approveSuggestion(db, { organizationId: fixture.org.id, suggestionId: suggestion.id, reviewerId: fixture.user.id }),
    ).rejects.toBeInstanceOf(SuggestionApplyError);

    const allProjects = await db.select().from(projects).where(eq(projects.organizationId, fixture.org.id));
    expect(allProjects).toHaveLength(1); // only the fixture's own project -- nothing partially created
  });

  it("throws SuggestionApplyError when a new task's proposedDiff is missing projectId", async () => {
    const fixture = await createFixtureOrg(db, { domain: "missing-required-field-task.test" });

    const [suggestion] = await db
      .insert(suggestions)
      .values({
        organizationId: fixture.org.id,
        sourceId: fixture.source.id,
        targetType: "task",
        targetId: null,
        changeType: "new_task",
        proposedDiff: { title: "A task with no project" },
        reasoning: "test",
        confidence: 0.6,
      })
      .returning();

    await expect(
      approveSuggestion(db, { organizationId: fixture.org.id, suggestionId: suggestion.id, reviewerId: fixture.user.id }),
    ).rejects.toBeInstanceOf(SuggestionApplyError);
  });

  it("still succeeds normally when all required fields are present", async () => {
    const fixture = await createFixtureOrg(db, { domain: "required-fields-present.test" });

    const [suggestion] = await db
      .insert(suggestions)
      .values({
        organizationId: fixture.org.id,
        sourceId: fixture.source.id,
        targetType: "project",
        targetId: null,
        changeType: "new_task",
        proposedDiff: { initiativeId: fixture.initiative.id, title: "A well-formed new project" },
        reasoning: "test",
        confidence: 0.6,
      })
      .returning();

    const updated = await approveSuggestion(db, {
      organizationId: fixture.org.id,
      suggestionId: suggestion.id,
      reviewerId: fixture.user.id,
    });
    expect(updated.status).toBe("approved");
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

  it("includes only the fields the diff actually touches, plus title, pulled from the live target row", async () => {
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
    // status/latestUpdate from the diff, plus title always -- owner is in
    // neither the diff nor the always-included set, so it must not leak in.
    expect(body.suggestions[0].currentState).toEqual({
      status: "active",
      latestUpdate: "Original latest update",
      title: "Original title",
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
    expect(body.suggestions[0].currentState).toEqual({
      relevantContext: "Original context.",
      title: "Approve vendor switch",
    });
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

describe("GET /api/suggestions breadcrumb", () => {
  beforeEach(async () => {
    await truncateAll(db);
  });

  it("resolves the full objective/initiative/project chain for an update to an existing task", async () => {
    const fixture = await createFixtureOrg(db, { domain: "breadcrumb-task-update.test" });

    const [existingTask] = await db
      .insert(tasks)
      .values({ organizationId: fixture.org.id, projectId: fixture.project.id, title: "Task", status: "active" })
      .returning();

    await db.insert(suggestions).values({
      organizationId: fixture.org.id,
      sourceId: fixture.source.id,
      targetType: "task",
      targetId: existingTask.id,
      changeType: "operational_update",
      proposedDiff: { status: "blocked" },
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

    const body = response.json() as {
      suggestions: Array<{
        breadcrumb: { objective?: { title: string }; initiative?: { title: string }; project?: { title: string } } | null;
      }>;
    };
    expect(body.suggestions[0].breadcrumb).toEqual({
      objective: { id: fixture.objective.id, title: "Test objective" },
      initiative: { id: fixture.initiative.id, title: "Test initiative" },
      project: { id: fixture.project.id, title: "Test project" },
    });
  });

  it("resolves the breadcrumb for a brand-new task off the proposed projectId, since there's no existing row yet", async () => {
    const fixture = await createFixtureOrg(db, { domain: "breadcrumb-task-new.test" });

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

    const body = response.json() as {
      suggestions: Array<{ breadcrumb: { project?: { title: string } } | null }>;
    };
    expect(body.suggestions[0].breadcrumb?.project).toEqual({ id: fixture.project.id, title: "Test project" });
  });

  it("is null for an objective target and for a decision target, since neither has a parent chain to show", async () => {
    const fixture = await createFixtureOrg(db, { domain: "breadcrumb-none.test" });

    await db.insert(suggestions).values([
      {
        organizationId: fixture.org.id,
        sourceId: fixture.source.id,
        targetType: "objective",
        targetId: fixture.objective.id,
        changeType: "context",
        proposedDiff: { description: "Adds context." },
        reasoning: "test",
        confidence: 0.7,
      },
      {
        organizationId: fixture.org.id,
        sourceId: fixture.source.id,
        targetType: "decision",
        targetId: null,
        changeType: "decision",
        proposedDiff: { title: "New decision", decider: "CEO" },
        reasoning: "test",
        confidence: 0.6,
      },
    ]);

    const app = await buildApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/suggestions",
      cookies: { [SESSION_COOKIE_NAME]: await tokenFor(fixture) },
    });
    await app.close();

    const body = response.json() as { suggestions: Array<{ breadcrumb: unknown }> };
    expect(body.suggestions).toHaveLength(2);
    for (const s of body.suggestions) {
      expect(s.breadcrumb).toBeNull();
    }
  });

  it("never leaks another organization's project/initiative/objective titles into the breadcrumb", async () => {
    const orgA = await createFixtureOrg(db, { domain: "breadcrumb-org-a.test" });
    const orgB = await createFixtureOrg(db, { domain: "breadcrumb-org-b.test" });

    // A suggestion in org A's queue whose proposedDiff points at org B's own
    // project id -- the breadcrumb resolver must org-scope its project/
    // initiative/objective lookups the same way loadCurrentStates does.
    await db.insert(suggestions).values({
      organizationId: orgA.org.id,
      sourceId: orgA.source.id,
      targetType: "task",
      targetId: null,
      changeType: "new_task",
      proposedDiff: { projectId: orgB.project.id, title: "Cross-org task" },
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

    const body = response.json() as { suggestions: Array<{ breadcrumb: unknown }> };
    expect(body.suggestions[0].breadcrumb).toBeNull();
  });
});

describe("GET /api/suggestions movingToProject", () => {
  beforeEach(async () => {
    await truncateAll(db);
  });

  it("is set when an update suggestion's proposedDiff sets a projectId different from the task's current one", async () => {
    const fixture = await createFixtureOrg(db, { domain: "moving-to-basic.test" });

    const [otherProject] = await db
      .insert(projects)
      .values({ organizationId: fixture.org.id, initiativeId: fixture.initiative.id, title: "Bench testing protocol" })
      .returning();

    const [existingTask] = await db
      .insert(tasks)
      .values({ organizationId: fixture.org.id, projectId: fixture.project.id, title: "Task", status: "active" })
      .returning();

    await db.insert(suggestions).values({
      organizationId: fixture.org.id,
      sourceId: fixture.source.id,
      targetType: "task",
      targetId: existingTask.id,
      changeType: "operational_update",
      proposedDiff: { projectId: otherProject.id },
      reasoning: "Re-triage match.",
      confidence: 0.8,
    });

    const app = await buildApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/suggestions",
      cookies: { [SESSION_COOKIE_NAME]: await tokenFor(fixture) },
    });
    await app.close();

    const body = response.json() as { suggestions: Array<{ movingToProject: { id: string; title: string } | null }> };
    expect(body.suggestions[0].movingToProject).toEqual({ id: otherProject.id, title: "Bench testing protocol" });
  });

  it("is null when proposedDiff's projectId is the same as the task's current project (no real move)", async () => {
    const fixture = await createFixtureOrg(db, { domain: "moving-to-unchanged.test" });

    const [existingTask] = await db
      .insert(tasks)
      .values({ organizationId: fixture.org.id, projectId: fixture.project.id, title: "Task", status: "active" })
      .returning();

    await db.insert(suggestions).values({
      organizationId: fixture.org.id,
      sourceId: fixture.source.id,
      targetType: "task",
      targetId: existingTask.id,
      changeType: "operational_update",
      // Restates the same projectId the task is already in -- not a move.
      proposedDiff: { projectId: fixture.project.id, status: "blocked" },
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

    const body = response.json() as { suggestions: Array<{ movingToProject: unknown }> };
    expect(body.suggestions[0].movingToProject).toBeNull();
  });

  it("is null for a brand-new task (targetId null) even though its proposedDiff sets projectId", async () => {
    const fixture = await createFixtureOrg(db, { domain: "moving-to-new-task.test" });

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

    const body = response.json() as { suggestions: Array<{ movingToProject: unknown }> };
    expect(body.suggestions[0].movingToProject).toBeNull();
  });

  it("never leaks another organization's project title into movingToProject", async () => {
    const orgA = await createFixtureOrg(db, { domain: "moving-to-org-a.test" });
    const orgB = await createFixtureOrg(db, { domain: "moving-to-org-b.test" });

    const [existingTask] = await db
      .insert(tasks)
      .values({ organizationId: orgA.org.id, projectId: orgA.project.id, title: "Task", status: "active" })
      .returning();

    await db.insert(suggestions).values({
      organizationId: orgA.org.id,
      sourceId: orgA.source.id,
      targetType: "task",
      targetId: existingTask.id,
      changeType: "operational_update",
      proposedDiff: { projectId: orgB.project.id },
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

    const body = response.json() as { suggestions: Array<{ movingToProject: unknown }> };
    expect(body.suggestions[0].movingToProject).toBeNull();
  });
});

describe("GET /api/suggestions conflicts", () => {
  beforeEach(async () => {
    await truncateAll(db);
  });

  it("returns the conflicts array when present, org-scoped", async () => {
    const fixture = await createFixtureOrg(db, { domain: "conflicts-field-present.test" });

    const [existingTask] = await db
      .insert(tasks)
      .values({ organizationId: fixture.org.id, projectId: fixture.project.id, title: "Task", status: "completed" })
      .returning();

    const conflictsPayload = [
      {
        field: "status",
        proposedValue: "active",
        proposedSourceId: fixture.source.id,
        proposedAsOf: "2026-08-01T00:00:00.000Z",
        currentValue: "completed",
        currentAsOf: "2026-08-15T00:00:00.000Z",
      },
    ];

    await db.insert(suggestions).values({
      organizationId: fixture.org.id,
      sourceId: fixture.source.id,
      targetType: "task",
      targetId: existingTask.id,
      changeType: "operational_update",
      proposedDiff: {},
      reasoning: "test",
      confidence: 0.6,
      conflicts: conflictsPayload,
    });

    const app = await buildApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/suggestions",
      cookies: { [SESSION_COOKIE_NAME]: await tokenFor(fixture) },
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    const body = response.json() as { suggestions: Array<{ conflicts: unknown }> };
    expect(body.suggestions[0].conflicts).toEqual(conflictsPayload);
  });

  it("is null for an ordinary suggestion with no conflict", async () => {
    const fixture = await createFixtureOrg(db, { domain: "conflicts-field-null.test" });

    await db.insert(suggestions).values({
      organizationId: fixture.org.id,
      sourceId: fixture.source.id,
      targetType: "task",
      targetId: null,
      changeType: "new_task",
      proposedDiff: { projectId: fixture.project.id, title: "New task" },
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

    const body = response.json() as { suggestions: Array<{ conflicts: unknown }> };
    expect(body.suggestions[0].conflicts).toBeNull();
  });
});

describe("POST /api/suggestions/bulk-approve", () => {
  beforeEach(async () => {
    await truncateAll(db);
  });

  async function newTaskSuggestion(fixture: Awaited<ReturnType<typeof createFixtureOrg>>, title: string) {
    const [suggestion] = await db
      .insert(suggestions)
      .values({
        organizationId: fixture.org.id,
        sourceId: fixture.source.id,
        targetType: "task",
        targetId: null,
        changeType: "new_task",
        proposedDiff: { projectId: fixture.project.id, title },
        reasoning: "test",
        confidence: 0.6,
      })
      .returning();
    return suggestion;
  }

  it("returns 400 when ids is missing or empty", async () => {
    const fixture = await createFixtureOrg(db, { domain: "bulk-approve-missing-ids.test" });
    const app = await buildApp();
    const cookies = { [SESSION_COOKIE_NAME]: await tokenFor(fixture) };

    const missing = await app.inject({ method: "POST", url: "/api/suggestions/bulk-approve", payload: {}, cookies });
    expect(missing.statusCode).toBe(400);

    const empty = await app.inject({ method: "POST", url: "/api/suggestions/bulk-approve", payload: { ids: [] }, cookies });
    expect(empty.statusCode).toBe(400);

    await app.close();
  });

  it("returns 400 when more than 100 ids are submitted at once", async () => {
    const fixture = await createFixtureOrg(db, { domain: "bulk-approve-too-many.test" });
    const app = await buildApp();
    const ids = Array.from({ length: 101 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);

    const response = await app.inject({
      method: "POST",
      url: "/api/suggestions/bulk-approve",
      payload: { ids },
      cookies: { [SESSION_COOKIE_NAME]: await tokenFor(fixture) },
    });
    await app.close();

    expect(response.statusCode).toBe(400);
  });

  it("approves every valid pending suggestion and reports their ids", async () => {
    const fixture = await createFixtureOrg(db, { domain: "bulk-approve-happy-path.test" });
    const a = await newTaskSuggestion(fixture, "Task A");
    const b = await newTaskSuggestion(fixture, "Task B");

    const app = await buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/suggestions/bulk-approve",
      payload: { ids: [a.id, b.id] },
      cookies: { [SESSION_COOKIE_NAME]: await tokenFor(fixture) },
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    const body = response.json() as { approved: string[]; failed: Array<{ id: string; error: string }> };
    expect(body.approved.sort()).toEqual([a.id, b.id].sort());
    expect(body.failed).toEqual([]);

    const allTasks = await db.select().from(tasks).where(eq(tasks.organizationId, fixture.org.id));
    expect(allTasks).toHaveLength(2);

    const [refreshedA] = await db.select().from(suggestions).where(eq(suggestions.id, a.id));
    expect(refreshedA.status).toBe("approved");
  });

  it("reports an already-approved suggestion as failed without aborting the rest of the batch", async () => {
    const fixture = await createFixtureOrg(db, { domain: "bulk-approve-partial-failure.test" });
    const alreadyApproved = await newTaskSuggestion(fixture, "Already approved");
    const stillPending = await newTaskSuggestion(fixture, "Still pending");

    await approveSuggestion(db, {
      organizationId: fixture.org.id,
      suggestionId: alreadyApproved.id,
      reviewerId: fixture.user.id,
    });

    const app = await buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/suggestions/bulk-approve",
      payload: { ids: [alreadyApproved.id, stillPending.id] },
      cookies: { [SESSION_COOKIE_NAME]: await tokenFor(fixture) },
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    const body = response.json() as { approved: string[]; failed: Array<{ id: string; error: string }> };
    expect(body.approved).toEqual([stillPending.id]);
    expect(body.failed).toHaveLength(1);
    expect(body.failed[0].id).toBe(alreadyApproved.id);
  });

  it("cannot bulk-approve a suggestion belonging to a different organization -- it comes back failed, not approved", async () => {
    const orgA = await createFixtureOrg(db, { domain: "bulk-approve-org-a.test" });
    const orgB = await createFixtureOrg(db, { domain: "bulk-approve-org-b.test" });
    const crossOrgSuggestion = await newTaskSuggestion(orgB, "Belongs to org B");

    const app = await buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/suggestions/bulk-approve",
      payload: { ids: [crossOrgSuggestion.id] },
      cookies: { [SESSION_COOKIE_NAME]: await tokenFor(orgA) },
    });
    await app.close();

    const body = response.json() as { approved: string[]; failed: Array<{ id: string }> };
    expect(body.approved).toEqual([]);
    expect(body.failed).toHaveLength(1);

    const [untouched] = await db.select().from(suggestions).where(eq(suggestions.id, crossOrgSuggestion.id));
    expect(untouched.status).toBe("pending");
  });

  // Real production bug: a malformed suggestion (a new-project proposal
  // missing initiativeId) threw a raw, uncaught DB error mid-batch, which
  // crashed the whole request with a 500 instead of reporting it as one
  // failed item -- the other valid ids in the same batch never got a
  // response at all, even though their own approvals may have already
  // committed. apply.ts's REQUIRED_CREATE_FIELDS check now turns this into
  // an ordinary SuggestionApplyError; this also covers the route's own
  // defense-in-depth catch-all for any other unexpected error.
  it("reports a malformed suggestion as failed rather than 500ing the whole batch", async () => {
    const fixture = await createFixtureOrg(db, { domain: "bulk-approve-malformed-item.test" });
    const good = await newTaskSuggestion(fixture, "Good task");
    const [malformed] = await db
      .insert(suggestions)
      .values({
        organizationId: fixture.org.id,
        sourceId: fixture.source.id,
        targetType: "project",
        targetId: null,
        changeType: "new_task",
        proposedDiff: { title: "A project with no initiative" }, // missing initiativeId
        reasoning: "test",
        confidence: 0.6,
      })
      .returning();

    const app = await buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/suggestions/bulk-approve",
      payload: { ids: [good.id, malformed.id] },
      cookies: { [SESSION_COOKIE_NAME]: await tokenFor(fixture) },
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    const body = response.json() as { approved: string[]; failed: Array<{ id: string; error: string }> };
    expect(body.approved).toEqual([good.id]);
    expect(body.failed).toHaveLength(1);
    expect(body.failed[0].id).toBe(malformed.id);
  });

  it("returns 401 for an unauthenticated request", async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/suggestions/bulk-approve",
      payload: { ids: ["00000000-0000-4000-8000-000000000000"] },
    });
    await app.close();
    expect(response.statusCode).toBe(401);
  });
});
