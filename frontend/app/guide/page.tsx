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
                <strong>Strategic question</strong> <span className="muted">what the objective depends on, e.g. Can we sample reliably enough?</span>
                <ol>
                  <li>
                    <strong>Decisions and work</strong> <span className="muted">the calls to make and the tasks/projects that answer it</span>
                  </li>
                </ol>
              </li>
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
            [
              "Strategic questions",
              "The few big open questions an objective depends on, each with a working hypothesis. Decisions, tasks and projects are linked to them (not moved), and the Executive review rolls each one up to a single status.",
            ],
            ["Decisions", "Specific calls with a decider and (ideally) a due date. They can be linked to the task they block and be part of a strategic question."],
            ["Relationships", "Links between any two items: depends on, blocks, informs, consider together, and so on. They show on cards as “Waiting on”, “Informed by” and “Consider together with”."],
            ["Company context", "A short profile of Exvade (programs, people, partners, priorities, abbreviations) that the AI reads before every interpretation and check."],
            ["Entities", "Outside organizations and people (vendors, sites, investors) that items can be linked to."],
            ["Unsorted", "Where a new task lands when the AI can't tell which project it belongs to."],
            ["Visibility", "Team items are visible to everyone; Leadership and Restricted items only to admins, everywhere including questions and suggestions."],
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
          <strong>AI reads it</strong>: screens out noise, removes patient identifiers, and, using the{" "}
          <Link href="/context">company context</Link>, matches it to existing objectives, projects, tasks and decisions.
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
          <Link href="/activity">Activity</Link>. Nothing is ever deleted: closed, merged and replaced records are kept and linked.
        </li>
      </ol>
      <p className="guide-note">
        If newer information disagrees with something already confirmed more recently, Pulse holds it back and flags the conflict
        rather than overwriting.
      </p>

      <h2 className="section-title">The Executive review</h2>
      <div className="card">
        <Defs
          items={[
            [
              "Executive priorities",
              "Your strategic questions, one card each: short title, the question, status, the next action (highlighted when it's yours), owner, key date and what it depends on. Related decisions, tasks and updates sit under Details. Until questions exist, the busiest workstreams stand in.",
            ],
            ["What changed", "The few meaningful updates since you last clicked Mark as reviewed (or the last two weeks)."],
            ["Needs my action", "Decisions you decide and your own work that's stuck or has a next step."],
            ["Upcoming deadlines", "Real dates in the next 90 days. A date that has passed never shows here; it moves to Data quality."],
            ["Waiting / blocked", "What's stuck, and on whom."],
            ["Decisions", "Open calls only, with why it matters, the decider and the recommended next step."],
            ["Program details", "Collapsed: every strategic question, workstream and flagged task in full."],
            ["Older / resolved", "Collapsed: decided-and-in-progress, resolved questions to close out, and records with no evidence in 90+ days (with Clean up stale records)."],
            ["Data quality / conflicts", "Conflicts, decisions past their deadline, and the Review queue. Opens by itself when something's there."],
            ["Review with ChatGPT", "Copy the whole review (company context and priorities first) for your own ChatGPT, or create a private 7-day link."],
          ]}
        />
      </div>

      <h2 className="section-title">AI checks</h2>
      <div className="card">
        <p className="guide-subhead">You run these (each uses a little AI credit; everything they find goes to Review):</p>
        <Defs
          items={[
            [
              "Draft with AI",
              <>
                <Link href="/context">Context</Link>. Drafts the company profile from what Pulse already knows, marking guesses
                &ldquo;(check)&rdquo;. Never saved until you click Save.
              </>,
            ],
            [
              "Suggest questions with AI",
              <>
                <Link href="/questions">Questions</Link>. Proposes strategic questions and the records that belong to each, and can
                suggest splitting an over-broad decision into a question with smaller decisions.
              </>,
            ],
            [
              "Clean up stale records",
              <>
                <Link href="/executive">Executive</Link>. For each old record or outdated next action, proposes one fix: close it,
                mark it covered by newer work, replace it with a new task, give it a new next action, or confirm it&rsquo;s still
                active. Never closes something just because it&rsquo;s old.
              </>,
            ],
            [
              "Check for contradictions",
              <>
                <Link href="/executive">Executive</Link>. Flags newer information that contradicts what&rsquo;s recorded, with a
                proposed correction.
              </>,
            ],
            [
              "Check for duplicates",
              <>
                <Link href="/company-map">Company Map</Link>. Proposes merging copies of tasks, decisions, projects, initiatives or
                objectives. Approving keeps one, marks the other superseded, and moves or copies what was under it.
              </>,
            ],
            ["Suggest relationships", <><Link href="/company-map">Company Map</Link>. Proposes links between related tasks and decisions.</>],
            ["Suggest where these belong", <><Link href="/unsorted">Unsorted</Link>. Proposes a project for each unsorted task.</>],
          ]}
        />
        <p className="guide-subhead">Automatic (free):</p>
        <Defs
          items={[
            ["Looks like a copy", "A note on new suggestions whose wording matches an existing item or another pending suggestion."],
            ["Deadline passed", "A Review item for any open decision past its due date, asking what actually happened. Clears itself once you act on the decision."],
            ["May be stale", "A next action or next step with no new evidence in 21+ days is flagged on its card."],
          ]}
        />
      </div>

      <h2 className="section-title">Your weekly routine</h2>
      <ol className="guide-steps">
        <li>
          Open <Link href="/executive">Executive</Link>. Scan the <em>priorities</em>, <em>What changed</em> and <em>Needs my action</em>.
        </li>
        <li>
          Check <em>Upcoming deadlines</em> and <em>Waiting / blocked</em>, resolve anything in <em>Data quality</em>, then work through{" "}
          <em>Decisions</em>.
        </li>
        <li>
          Clear the <Link href="/review">Review</Link> queue. Start with <em>Ready to approve</em>; the high-confidence items can be
          bulk-approved.
        </li>
        <li>
          Deal with <em>Needs disposition</em>: <em>Mark done</em>, <em>Not relevant anymore</em>, or run{" "}
          <em>Clean up stale records</em> and review what it proposes.
        </li>
        <li>
          Click <em>Mark as reviewed</em>, so next time Pulse shows only what changed. Optionally, <em>Copy for ChatGPT</em> for a
          second opinion.
        </li>
      </ol>
      <p className="guide-note">
        Every month or so: check for duplicates and contradictions, suggest new strategic questions, and keep the{" "}
        <Link href="/context">company context</Link> current. Better context means better suggestions.
      </p>

      <h2 className="section-title">What the labels mean</h2>
      <div className="card">
        <p className="guide-subhead">Tasks</p>
        <Defs
          items={[
            ["Active / Waiting", "In progress / waiting on someone else."],
            ["Needs attention / Blocked", "Something's wrong / can't move until something (often a decision) happens."],
            ["Completed / Resolved", "Done."],
            ["Cancelled", "Not relevant anymore. Kept for history, hidden from lists."],
            ["Superseded", "Merged into, or replaced by, another task."],
            ["Needs disposition", "No new evidence in 90+ days: probably stale, not urgent. Close it or confirm it."],
          ]}
        />
        <p className="guide-subhead">Decisions</p>
        <Defs
          items={[
            ["Open / Waiting on info", "Needs a call / can't decide yet."],
            ["Decided / In progress", "Call made / being carried out."],
            ["Closed / Superseded", "Finished / merged into another decision, or converted into a strategic question."],
            ["Deadline passed", "Still open after its due date: confirm what happened."],
          ]}
        />
        <p className="guide-subhead">Strategic questions and workstreams</p>
        <Defs
          items={[
            ["Needs attention", "Something linked is blocked or flagged, has a conflict, or a decision is past its deadline."],
            ["Decision needed", "Nothing is stuck, but a linked decision is still open."],
            ["Waiting / On track", "Linked work is waiting on someone / moving normally."],
            ["Resolved", "Answered. If decisions under it are still open, Pulse keeps reminding you to close or update them; it never closes them for you."],
          ]}
        />
        <p className="guide-subhead">Review cards</p>
        <Defs
          items={[
            ["Update / New", "A change to an existing item, or a new task or decision."],
            ["Possible duplicate", "Merge one record into another (nothing deleted)."],
            ["Cleanup", "Close, confirm, or give a new next action to a stale record."],
            ["Replace", "The work has changed: create a new task and supersede the old one."],
            ["Conflict detected", "A proposed correction where newer information disagrees with what's recorded."],
            ["New strategic question", "A proposed question with its linked records, or a broad decision converted into one."],
          ]}
        />
        <p className="guide-note">
          <strong>Attention score</strong> ranks work by the objective&rsquo;s priority, urgency, whether it&rsquo;s waiting on a
          decision, whether it has a next step, and how fresh its evidence is. Age alone never makes something urgent.
        </p>
      </div>

      <h2 className="section-title">Signing in</h2>
      <div className="card">
        <Defs
          items={[
            ["Invite only", "Anyone an admin adds on the Users page can sign in with that Google account, on any email domain."],
            ["Any browser", "Works in Chrome, Safari (including iPhone and iPad), Firefox, Edge, Brave and Incognito windows."],
            ["Not approved yet?", "Ask an Exvade admin to add the exact Google email you're signing in with."],
            ["View-only links", "Admins can create a password-protected link on the Integrations page that opens Read-Only Review Mode (e.g. for a ChatGPT agent to review the site). It browses every page with action buttons disabled, can never change anything, expires on its own, and can be switched off at any time."],
          ]}
        />
      </div>

      <h2 className="section-title">Pages at a glance</h2>
      <div className="card">
        <Defs
          items={[
            [<Link href="/">Dashboard</Link>, "Quick status: decisions needed, counts, what needs attention."],
            [<Link href="/executive">Executive</Link>, "The weekly review: what needs you, what changed, what's stale."],
            [<Link href="/questions">Questions</Link>, "Strategic questions: add, link records, resolve with an answer, or let the AI suggest them."],
            [<Link href="/company-map">Company Map</Link>, "The whole tree; duplicate and relationship checks."],
            [<Link href="/review">Review</Link>, "Approve, edit or reject every AI suggestion; add your own updates."],
            [<Link href="/decisions">Decisions</Link>, "Work open decisions: add info, assign, decide, close."],
            [<Link href="/unsorted">Unsorted</Link>, "Tasks waiting for a home."],
            [<Link href="/reports/weekly">Weekly Report</Link>, "A fixed summary of one week."],
            [<Link href="/activity">Activity</Link>, "Everything that changed, and who approved it."],
            [<Link href="/context">Context</Link>, "The company profile the AI reads. Admins edit it; everyone can read it."],
            ["Users, Integrations", "Admins: invite people; connect Gmail, Circleback and ChatGPT."],
            [<Link href="/privacy">Privacy</Link>, "How Pulse handles data."],
          ]}
        />
      </div>
    </main>
  );
}
