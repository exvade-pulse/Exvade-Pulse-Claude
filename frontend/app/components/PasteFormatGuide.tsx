"use client";

import { useState } from "react";

// How to update the Executive Overview by pasting into "Paste review
// findings". Shown next to the paste box and on the Guide page. The format
// is forgiving (the AI reads it), but following it gets every line matched.

export const BLANK_TEMPLATE = `OUTCOME: <exact outcome name, as on the Overview>
Health: On track | At risk | Blocked | Not assessed
Why: <one line: why that rating>
Why it matters: <one sentence>
Owner: <name>
Order: <1 = first on the Overview>
Milestones:
- <milestone name> | baseline YYYY-MM-DD | forecast YYYY-MM-DD | confidence committed|forecast|unconfirmed | owner <name> | done when: <text>
Risks:
- <risk name> | impact: <text> | likelihood: <low/medium/high> | mitigation: <text> | owner <name> | review by YYYY-MM-DD | watching|decision needed | affects: <milestone name>
Decisions:
- <exact open decision name> | recommendation: <text> | if delayed: <text>`;

const RULES: Array<[string, string]> = [
  ["One block per outcome", "Start each with OUTCOME: and the outcome's exact name. Leave a blank line between outcomes, and no blank lines inside one."],
  ["Leave out what isn't changing", "Any line or piece you skip stays as it is. A blank or \"-\" means no change, not \"clear it\"."],
  ["Health needs a reason", "Health: must come with Why:, unless it's Not assessed. A rating without a reason is listed as not applied."],
  ["Dates", "Always YYYY-MM-DD. baseline = the committed plan; forecast = today's best estimate. A milestone with no date: confidence unconfirmed."],
  ["Milestone status", "Add achieved YYYY-MM-DD, missed or dropped to the line. A name matching an existing milestone updates it; a new name adds one."],
  ["Moving a committed baseline", "Allowed in the paste, but only an admin can approve that card."],
  ["Risks", "watching or decision needed; add closed to close one. affects: must name a milestone of the same outcome."],
  ["Decisions", "Must name an existing open decision. It's attached to this outcome with your recommendation; nothing new is created."],
  ["Tasks and other records", "Plain sentences still work for everything else, e.g. Move task \"X\" into project \"Y\", or Set task \"X\" due 2026-11-01."],
  ["Nothing changes until you approve", "Every line becomes a card in Review. Lines that can't be matched are listed with the reason."],
];

export function PasteFormatGuide({ onFill }: { onFill?: (text: string) => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <details className="xo-details paste-guide">
      <summary>Updating the Overview by paste: format guide</summary>
      <p className="xo-meta">
        Paste one block per outcome. Easiest: {onFill ? "click Fill in current values, edit what changed, then Read findings." : "on Review, click Fill in current values, edit what changed and read it."}
      </p>
      <pre className="paste-template">{BLANK_TEMPLATE}</pre>
      <div className="card-actions">
        <button
          type="button"
          className="decision-btn"
          onClick={async () => {
            await navigator.clipboard.writeText(BLANK_TEMPLATE);
            setCopied(true);
          }}
        >
          {copied ? "Copied" : "Copy blank template"}
        </button>
        {onFill && (
          <button type="button" className="decision-btn" onClick={() => onFill(BLANK_TEMPLATE)}>
            Put blank template in the box
          </button>
        )}
      </div>
      <dl className="paste-rules">
        {RULES.map(([term, text]) => (
          <div key={term}>
            <dt>{term}</dt>
            <dd>{text}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}
