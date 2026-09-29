"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { fetchCurrentUser, type SessionUser } from "../../lib/api";
import { Nav } from "../components/Nav";

function Defs({ items }: { items: Array<[React.ReactNode, React.ReactNode]> }) {
  return (
    <dl className="guide-defs">
      {items.map(([term, text], i) => (
        <div key={i}>
          <dt>{term}</dt>
          <dd>{text}</dd>
        </div>
      ))}
    </dl>
  );
}

export default function GuidePage() {
  const [user, setUser] = useState<SessionUser | null | "loading">("loading");

  useEffect(() => {
    fetchCurrentUser().then(setUser);
  }, []);

  return (
    <main className="page guide">
      <Nav user={user === "loading" ? undefined : user} />
      <div className="header">
        <h1>How Pulse works</h1>
      </div>
      <p className="guide-lead">
        Pulse keeps one up-to-date picture of what Exvade is doing. AI reads incoming information and <strong>proposes</strong>{" "}
        changes; a person approves every one.
      </p>

      <h2 className="section-title">How things are organized</h2>
      <div className="card">
        <ol className="guide-tree">
          <li>
            <strong>Objective</strong> <span className="muted">a company goal, e.g. Advance the Tumor Monorail toward a pivotal trial</span>
            <ol>
              <li>
                <strong>Initiative</strong> <span className="muted">a workstream, e.g. Pre-clinical validation</span>
                <ol>
                  <li>
                    <strong>Project</strong> <span className="muted">e.g. Bench testing protocol</span>
                    <ol>
                      <li>
                        <strong>Task</strong> <span className="muted">e.g. Recalibrate sensor rig #3</span>
                      </li>
                    </ol>
                  </li>
                </ol>
              </li>
            </ol>
          </li>
        </ol>
        <Defs
          items={[
            ["Strategic questions", "The few big open questions an objective depends on (e.g. Can we sample reliably enough?), with a working hypothesis. Decisions, tasks and projects are linked to them; the Executive review rolls each one up to a single status."],
            ["Decisions", "Specific calls with a decider and (ideally) a due date. They sit alongside the tree, can be linked to the task they block, and can be part of a strategic question."],
            ["Relationships", "Links between any two items: depends on, blocks, informs, and so on. Shown on each item's page."],
            ["Entities", "Outside organizations and people (vendors, sites, investors) that items can be linked to."],
            ["Unsorted", "Where a new task lands when the AI can't tell which project it belongs to."],
            ["Visibility", "Team items are visible to everyone; Leadership and Restricted items only to admins."],
          ]}
        />
      </div>

      <h2 className="section-title">How information becomes a change</h2>
      <ol className="guide-steps">
        <li>
          <strong>Information arrives</strong> from the connected Gmail inbox, Circleback meeting notes, imported documents, notes you
          type (<em>Add update</em> on the Review page), or your ChatGPT assistant.
        </li>
        <li>
          <strong>AI reads it</strong>: screens out noise, removes patient identifiers, and matches it to existing objectives,
          projects, tasks and decisions.
        </li>
        <li>
          <strong>AI proposes changes</strong> as suggestions (update a task, add a task or decision, link two items), each with its
          reasoning and a confidence score.
        </li>
        <li>
          <strong>You review</strong> on the <Link href="/review">Review</Link> page: <em>Approve</em>, <em>Edit</em> then approve, or{" "}
          <em>Reject</em>. Nothing changes until you do.
        </li>
        <li>
          <strong>It&rsquo;s applied and traceable</strong>: every change keeps its source (<em>View source</em>) and shows up in{" "}
          <Link href="/activity">Activity</Link>.
        </li>
      </ol>
      <p className="guide-note">
        If newer information disagrees with something already confirmed more recently, Pulse holds it back and flags the conflict
        rather than overwriting.
      </p>

      <h2 className="section-title">AI checks</h2>
      <div className="card">
        <p className="guide-subhead">You run these (each uses a little AI credit):</p>
        <Defs
          items={[
            ["Check for duplicates", <>Company Map. Proposes merging copies of tasks, decisions, projects, initiatives or objectives; approving keeps one, marks the other superseded, and moves or copies what was under it. Nothing is deleted.</>],
            ["Suggest questions with AI", <>Questions. Proposes strategic questions and the records that belong to each, and can suggest splitting an over-broad decision into a question with smaller decisions.</>],
            ["Clean up stale records", <>Executive. For each old record or outdated next action, proposes one fix: close it, mark it covered by newer work, replace it, give it a new next action, or confirm it            ["Check for duplicates", <>Company Map. Proposes merging copies; approving keeps one, marks the other superseded, and copies its notes over. Nothing is deleted.</>],rsquo;s still active.</>],
            ["Suggest relationships", <>Company Map. Proposes links between related tasks and decisions.</>],
            ["Suggest where these belong", <>Unsorted. Proposes a project for each unsorted task.</>],
            ["Check for contradictions", <>Executive. Flags newer information that contradicts what&rsquo;s recorded, with a proposed correction.</>],
          ]}
        />
        <p className="guide-subhead">Automatic (free):</p>
        <Defs
          items={[
            ["Looks like a copy", "A note on new suggestions whose wording matches an existing item or another pending suggestion."],
            ["Deadline passed", "A Review item for any open decision past its due date, asking what actually happened. Clears itself once you act on the decision."],
          ]}
        />
      </div>

      <h2 className="section-title">Your weekly routine</h2>
      <ol className="guide-steps">
        <li>
          Open <Link href="/executive">Executive</Link>. Read <em>This week</em> and <em>Since last review</em>.
        </li>
        <li>Scan <em>Focus</em> and <em>Strategic questions</em>. Resolve <em>Conflicts</em> and <em>Deadline passed</em> items, then work through <em>Decisions needed</em>.</li>
        <li>
          Clear the <Link href="/review">Review</Link> queue. Start with <em>Ready to approve</em>; the high-confidence items can be
          bulk-approved.
        </li>
        <li>
          Close out <em>Needs disposition</em> items: <em>Mark done</em> or <em>Not relevant anymore</em>.
        </li>
        <li>
          Click <em>Mark as reviewed</em>, so next time Pulse shows only what changed. Optionally, <em>Copy for ChatGPT</em> for a
          second opinion.
        </li>
      </ol>

      <h2 className="section-title">What the labels mean</h2>
      <div className="card">
        <p className="guide-subhead">Tasks</p>
        <Defs
          items={[
            ["Active / Waiting", "In progress / waiting on someone else."],
            ["Needs attention / Blocked", "Something's wrong / can't move until something (often a decision) happens."],
            ["Completed / Resolved", "Done."],
            ["Cancelled", "Not relevant anymore. Kept for history, hidden from lists."],
            ["Superseded", "Merged into another task."],
            ["Needs disposition", "No new evidence in 90+ days: probably stale, not urgent. Close it or confirm it."],
          ]}
        />
        <p className="guide-subhead">Decisions</p>
        <Defs
          items={[
            ["Open / Waiting on info", "Needs a call / can't decide yet."],
            ["Decided / In progress", "Call made / being carried out."],
            ["Closed / Superseded", "Finished / merged into another decision."],
            ["Deadline passed", "Still open after its due date: confirm what happened."],
          ]}
        />
        <p className="guide-note">
          <strong>Attention score</strong> ranks work by the objective&rsquo;s priority, urgency, whether it&rsquo;s waiting on a
          decision, whether it has a next step, and how fresh its evidence is. Age alone never makes something urgent.
        </p>
      </div>

      <h2 className="section-title">Pages at a glance</h2>
      <div className="card">
        <Defs
          items={[
            [<Link href="/">Dashboard</Link>, "Quick status: decisions needed, counts, what needs attention."],
            [<Link href="/executive">Executive</Link>, "The weekly review: what needs you, what changed, what's stale."],
            [<Link href="/questions">Questions</Link>, "Strategic questions: add, link records, record the answer when resolved."],
            [<Link href="/company-map">Company Map</Link>, "The whole tree; duplicate and relationship checks."],
            [<Link href="/review">Review</Link>, "Approve, edit or reject every AI suggestion; add your own updates."],
            [<Link href="/decisions">Decisions</Link>, "Work open decisions: add info, assign, decide, close."],
            [<Link href="/unsorted">Unsorted</Link>, "Tasks waiting for a home."],
            [<Link href="/reports/weekly">Weekly Report</Link>, "A fixed summary of one week."],
            [<Link href="/activity">Activity</Link>, "Everything that changed, and who approved it."],
            ["Users, Integrations", "Admins: invite people; connect Gmail, Circleback and ChatGPT."],
          ]}
        />
      </div>
    </main>
  );
}
