"use client";

import type { CompanyMapResponse, Suggestion } from "../../lib/api";

// The "Move to" picker on a review card's Edit form: choose where a task,
// project or initiative should go, or name a new destination. A new one is
// only created when the card is approved (see backend apply.ts's NewParent),
// and an existing one with the same name in the same place is reused.

// Mirrors backend apply.ts's MOVABLE_CHANGE_TYPES and PARENT_OF.
const MOVABLE_CHANGE_TYPES = ["operational_update", "new_task"];
const PARENT = {
  task: { field: "projectId", level: "project" },
  project: { field: "initiativeId", level: "initiative" },
  initiative: { field: "objectiveId", level: "objective" },
} as const;
type Level = "objective" | "initiative" | "project";
const NEW = "__new__";

export interface MoveChoice {
  pick: string;
  newTitle: string;
  newUnder: string;
  initialPick: string;
}

export function moveTarget(s: Suggestion) {
  if (!(s.targetType in PARENT) || !MOVABLE_CHANGE_TYPES.includes(s.changeType)) return null;
  return PARENT[s.targetType as keyof typeof PARENT];
}

export function initialMoveChoice(s: Suggestion): MoveChoice | null {
  const target = moveTarget(s);
  if (!target) return null;
  const np = s.proposedDiff.newParent as { title?: string; parentId?: string | null } | undefined;
  if (np?.title) return { pick: NEW, newTitle: np.title, newUnder: np.parentId ?? "", initialPick: NEW };
  const proposed = s.proposedDiff[target.field];
  const current = s.targetId ? s.breadcrumb?.[target.level]?.id : undefined;
  const pick = typeof proposed === "string" ? proposed : (current ?? "");
  return { pick, newTitle: "", newUnder: "", initialPick: pick };
}

// What to add to the edit for this choice, or a message saying what's missing.
export function moveDiff(s: Suggestion, choice: MoveChoice): Record<string, unknown> | string {
  const target = moveTarget(s)!;
  if (choice.pick === NEW) {
    if (!choice.newTitle.trim()) return `Name the new ${target.level}.`;
    if (target.level !== "objective" && !choice.newUnder) return `Choose where the new ${target.level} goes.`;
    return { newParent: { title: choice.newTitle.trim(), parentId: target.level === "objective" ? null : choice.newUnder } };
  }
  if (!choice.pick || choice.pick === choice.initialPick) return {};
  return { [target.field]: choice.pick, newParent: null };
}

function destinationGroups(tree: CompanyMapResponse, level: Level) {
  const live = <T extends { status: string }>(items: T[]) => items.filter((i) => i.status !== "superseded");
  const objectives = live(tree.objectives);
  const groups =
    level === "objective"
      ? [{ label: "Objectives", items: objectives }]
      : level === "initiative"
        ? objectives.map((o) => ({ label: o.title, items: live(o.initiatives) }))
        : objectives.flatMap((o) => live(o.initiatives).map((i) => ({ label: `${o.title} › ${i.title}`, items: live(i.projects) })));
  return groups.filter((g) => g.items.length > 0);
}

function Options({ tree, level, current }: { tree: CompanyMapResponse; level: Level; current?: string }) {
  return (
    <>
      {destinationGroups(tree, level).map((g) => (
        <optgroup key={g.label} label={g.label}>
          {g.items.map((item) => (
            <option key={item.id} value={item.id}>
              {item.title}
              {item.id === current ? " (current)" : ""}
            </option>
          ))}
        </optgroup>
      ))}
    </>
  );
}

export function MovePicker({
  suggestion,
  tree,
  choice,
  onChange,
}: {
  suggestion: Suggestion;
  tree: CompanyMapResponse | null;
  choice: MoveChoice;
  onChange: (next: MoveChoice) => void;
}) {
  const target = moveTarget(suggestion)!;
  if (!tree) return <p className="muted">Loading destinations…</p>;
  const current = suggestion.targetId ? suggestion.breadcrumb?.[target.level]?.id : undefined;
  const home: Level | null = target.level === "project" ? "initiative" : target.level === "initiative" ? "objective" : null;

  return (
    <>
      <label className="edit-field">
        <span className="edit-field-label">{suggestion.targetId ? "Move to" : "Put in"}</span>
        <select className="edit-input" value={choice.pick} onChange={(e) => onChange({ ...choice, pick: e.target.value })}>
          {!choice.pick && <option value="">Choose {target.level === "project" ? "a" : "an"} {target.level}</option>}
          <Options tree={tree} level={target.level} current={current} />
          <option value={NEW}>+ New {target.level}…</option>
        </select>
      </label>
      {choice.pick === NEW && (
        <>
          <label className="edit-field">
            <span className="edit-field-label">Name of the new {target.level}</span>
            <input className="edit-input" value={choice.newTitle} onChange={(e) => onChange({ ...choice, newTitle: e.target.value })} />
          </label>
          {home && (
            <label className="edit-field">
              <span className="edit-field-label">The new {target.level} goes under</span>
              <select className="edit-input" value={choice.newUnder} onChange={(e) => onChange({ ...choice, newUnder: e.target.value })}>
                <option value="">Choose an {home}</option>
                <Options tree={tree} level={home} />
              </select>
            </label>
          )}
          <p className="muted">
            It&apos;s created when you approve this card. If one with the same name is already there, that one is used.
          </p>
        </>
      )}
    </>
  );
}
