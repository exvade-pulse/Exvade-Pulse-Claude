"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  createRelationship,
  deleteRelationship,
  fetchCompanyEntities,
  fetchCompanyMap,
  fetchOpenDecisions,
  fetchRelationships,
  RELATION_TYPES,
  type CompanyMapResponse,
  type EntityNodeType,
  type EntityRelationship,
  type RelationType,
} from "../../lib/api";

const TYPE_LABEL: Record<EntityNodeType, string> = {
  objective: "Objective",
  initiative: "Initiative",
  project: "Project",
  task: "Task",
  decision: "Decision",
  company_entity: "Company entity",
};

const RELATION_LABEL: Record<RelationType, string> = {
  depends_on: "depends on",
  blocks: "blocks",
  informs: "informs",
  affects: "affects",
  part_of: "part of",
  funded_by: "funded by",
  performed_by: "performed by",
  awaiting_response_from: "awaiting response from",
  coupled_with: "coupled with",
  constrains: "constrains",
};

// Only the four hierarchy types have a real detail page; a decision has no
// per-id route (see activity/page.tsx's same LINKABLE_ENTITY_TYPES gap) and a
// company entity's only page today is the flat /company-entities list.
function entityHref(type: EntityNodeType, id: string): string | null {
  if (type === "objective" || type === "initiative" || type === "project" || type === "task") return `/${type}s/${id}`;
  if (type === "decision") return "/decisions";
  if (type === "company_entity") return "/company-entities";
  return null;
}

interface Pickable {
  id: string;
  title: string;
}

function flattenCompanyMap(map: CompanyMapResponse) {
  const objectives: Pickable[] = [];
  const initiatives: Pickable[] = [];
  const projects: Pickable[] = [];
  const tasks: Pickable[] = [];
  for (const o of map.objectives) {
    objectives.push({ id: o.id, title: o.title });
    for (const i of o.initiatives) {
      initiatives.push({ id: i.id, title: i.title });
      for (const p of i.projects) {
        projects.push({ id: p.id, title: p.title });
        for (const t of p.tasks) {
          tasks.push({ id: t.id, title: t.title });
        }
      }
    }
  }
  return { objectives, initiatives, projects, tasks };
}

// Shared across the four hierarchy detail pages -- shows every relationship
// touching this one entity (either direction) and a small form to add a new
// one. entityType/entityId identify the entity this panel is attached to;
// the target of a new relationship is picked from a live-fetched list rather
// than typed as a raw id.
export function RelationshipsPanel({ entityType, entityId }: { entityType: EntityNodeType; entityId: string }) {
  const [relationships, setRelationships] = useState<EntityRelationship[] | "loading">("loading");
  const [loadError, setLoadError] = useState<string | null>(null);

  const [showForm, setShowForm] = useState(false);
  const [reversed, setReversed] = useState(false);
  const [relationType, setRelationType] = useState<RelationType>(RELATION_TYPES[0]);
  const [targetType, setTargetType] = useState<EntityNodeType>("task");
  const [targetId, setTargetId] = useState("");
  const [pickables, setPickables] = useState<Pickable[] | "loading">("loading");
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  function load() {
    fetchRelationships(entityType, entityId)
      .then(setRelationships)
      .catch((err) => setLoadError(err.message));
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [entityType, entityId]);

  useEffect(() => {
    if (!showForm) return;
    setTargetId("");
    setPickables("loading");
    if (targetType === "decision") {
      fetchOpenDecisions()
        .then((ds) => setPickables(ds.map((d) => ({ id: d.id, title: d.title }))))
        .catch(() => setPickables([]));
    } else if (targetType === "company_entity") {
      fetchCompanyEntities()
        .then((es) => setPickables(es.map((e) => ({ id: e.id, title: e.name }))))
        .catch(() => setPickables([]));
    } else {
      fetchCompanyMap()
        .then((map) => setPickables(flattenCompanyMap(map)[`${targetType}s` as "objectives" | "initiatives" | "projects" | "tasks"]))
        .catch(() => setPickables([]));
    }
  }, [showForm, targetType]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!targetId) {
      setActionError("Choose a target.");
      return;
    }
    setSaving(true);
    setActionError(null);
    try {
      const forward = { fromType: entityType, fromId: entityId, toType: targetType, toId: targetId };
      const backward = { fromType: targetType, fromId: targetId, toType: entityType, toId: entityId };
      await createRelationship({ ...(reversed ? backward : forward), relationType });
      setShowForm(false);
      setTargetId("");
      load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    setActionError(null);
    try {
      await deleteRelationship(id);
      load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Something went wrong");
    }
  }

  return (
    <div className="relationships-panel">
      <div className="header" style={{ marginBottom: 8 }}>
        <p className="section-title" style={{ margin: 0 }}>
          Relationships
        </p>
        <button className="decision-btn" onClick={() => setShowForm((v) => !v)}>
          {showForm ? "Cancel" : "Add relationship"}
        </button>
      </div>

      {loadError && <div className="error-banner">{loadError}</div>}
      {actionError && <div className="error-banner">{actionError}</div>}

      {showForm && (
        <form className="card edit-form" onSubmit={handleSubmit}>
          <label className="edit-field edit-field-checkbox">
            <input type="checkbox" checked={reversed} onChange={(e) => setReversed(e.target.checked)} />
            <span>
              {reversed
                ? `The target ${RELATION_LABEL[relationType]} this ${TYPE_LABEL[entityType].toLowerCase()}`
                : `This ${TYPE_LABEL[entityType].toLowerCase()} ${RELATION_LABEL[relationType]} the target`}{" "}
              (check to reverse)
            </span>
          </label>
          <label className="edit-field">
            <span className="edit-field-label">Relationship</span>
            <select
              className="edit-input"
              value={relationType}
              onChange={(e) => setRelationType(e.target.value as RelationType)}
            >
              {RELATION_TYPES.map((rt) => (
                <option key={rt} value={rt}>
                  {RELATION_LABEL[rt]}
                </option>
              ))}
            </select>
          </label>
          <label className="edit-field">
            <span className="edit-field-label">Target type</span>
            <select
              className="edit-input"
              value={targetType}
              onChange={(e) => setTargetType(e.target.value as EntityNodeType)}
            >
              {(Object.keys(TYPE_LABEL) as EntityNodeType[]).map((t) => (
                <option key={t} value={t}>
                  {TYPE_LABEL[t]}
                </option>
              ))}
            </select>
          </label>
          <label className="edit-field">
            <span className="edit-field-label">Target</span>
            {pickables === "loading" ? (
              <span className="muted">Loading…</span>
            ) : (
              <select className="edit-input" value={targetId} onChange={(e) => setTargetId(e.target.value)}>
                <option value="">Select…</option>
                {pickables.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.title}
                  </option>
                ))}
              </select>
            )}
          </label>
          <div className="card-actions">
            <button className="decision-btn save" type="submit" disabled={saving}>
              Save
            </button>
          </div>
        </form>
      )}

      {relationships === "loading" && <p className="muted">Loading…</p>}
      {relationships !== "loading" && relationships.length === 0 && !loadError && (
        <p className="empty-state">No relationships yet.</p>
      )}
      {relationships !== "loading" && relationships.length > 0 && (
        <div className="card task-list">
          {relationships.map((r) => {
            const href = entityHref(r.otherType, r.otherId);
            return (
              <div className="task-row" key={r.id}>
                <div className="task-row-top">
                  <span className="task-row-title">
                    {r.direction === "incoming" && (
                      <span className="muted" title="This relationship points at this entity, not from it">
                        &larr;{" "}
                      </span>
                    )}
                    {RELATION_LABEL[r.relationType]}{" "}
                    {href ? <Link href={href}>{r.otherName}</Link> : r.otherName}
                    <span className="muted"> ({TYPE_LABEL[r.otherType]})</span>
                  </span>
                  <button className="decision-btn" onClick={() => handleDelete(r.id)}>
                    Remove
                  </button>
                </div>
                {r.note && <p className="task-row-meta">{r.note}</p>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
