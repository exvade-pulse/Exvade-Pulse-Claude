"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  API_URL,
  checkDuplicateTasks,
  fetchCompanyMap,
  fetchCurrentUser,
  suggestRelationships,
  type CompanyMapInitiative,
  type CompanyMapObjective,
  type CompanyMapProject,
  type CompanyMapResponse,
  type DuplicateCheckResult,
  type RelationshipSuggestResult,
  type SessionUser,
} from "../../lib/api";
import { Nav } from "../components/Nav";

function Toggle({ open, hasChildren, onClick }: { open: boolean; hasChildren: boolean; onClick: () => void }) {
  return (
    <button className="tree-toggle" onClick={onClick} disabled={!hasChildren} aria-label={open ? "Collapse" : "Expand"}>
      {hasChildren ? (open ? "▾" : "▸") : ""}
    </button>
  );
}

function formatUpdated(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function UpdatedLine({ updatedAt }: { updatedAt: string }) {
  return (
    <span className="updated-line" title={new Date(updatedAt).toLocaleString()}>
      Updated {formatUpdated(updatedAt)}
    </span>
  );
}

function TaskRow({ task }: { task: CompanyMapProject["tasks"][number] }) {
  return (
    <div className="tree-task-row">
      <Link className="tree-title-link" href={`/tasks/${task.id}`}>
        {task.title}
      </Link>
      {task.owner && <span className="owner-line">Owner: {task.owner}</span>}
      {task.sourceCount > 0 && (
        <span className="chip" title="Approved suggestions citing a source">
          {task.sourceCount} source{task.sourceCount === 1 ? "" : "s"}
        </span>
      )}
      {task.blockingDecision && (
        <span className="tag-decision" title={`Blocked by open decision: ${task.blockingDecision.title}`}>
          blocked by decision
        </span>
      )}
      <span className="badge">{task.status.replace("_", " ")}</span>
      <UpdatedLine updatedAt={task.updatedAt} />
    </div>
  );
}

function ProjectNode({
  project,
  open,
  onToggle,
}: {
  project: CompanyMapProject;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="tree-node">
      <div className="tree-row">
        <Toggle open={open} hasChildren={project.tasks.length > 0} onClick={onToggle} />
        <Link className="tree-title-link" href={`/projects/${project.id}`}>
          {project.title}
        </Link>
        {project.owner && <span className="owner-line">Owner: {project.owner}</span>}
        <span className="badge">{project.status}</span>
        <UpdatedLine updatedAt={project.updatedAt} />
      </div>
      {open && (
        <div className="tree-children">
          {project.tasks.length === 0 && <p className="tree-empty">No tasks yet.</p>}
          {project.tasks.map((task) => (
            <TaskRow task={task} key={task.id} />
          ))}
        </div>
      )}
    </div>
  );
}

function InitiativeNode({
  initiative,
  open,
  onToggle,
  openProjects,
  onToggleProject,
}: {
  initiative: CompanyMapInitiative;
  open: boolean;
  onToggle: () => void;
  openProjects: Set<string>;
  onToggleProject: (id: string) => void;
}) {
  return (
    <div className="tree-node">
      <div className="tree-row">
        <Toggle open={open} hasChildren={initiative.projects.length > 0} onClick={onToggle} />
        <Link className="tree-title-link" href={`/initiatives/${initiative.id}`}>
          {initiative.title}
        </Link>
        {initiative.owner && <span className="owner-line">Owner: {initiative.owner}</span>}
        <span className={`badge badge-priority-${initiative.priority}`}>{initiative.priority}</span>
        <span className="badge">{initiative.status}</span>
        <UpdatedLine updatedAt={initiative.updatedAt} />
      </div>
      {open && (
        <div className="tree-children">
          {initiative.projects.length === 0 && <p className="tree-empty">No projects yet.</p>}
          {initiative.projects.map((project) => (
            <ProjectNode
              project={project}
              open={openProjects.has(project.id)}
              onToggle={() => onToggleProject(project.id)}
              key={project.id}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ObjectiveNode({
  objective,
  open,
  onToggle,
  openInitiatives,
  onToggleInitiative,
  openProjects,
  onToggleProject,
}: {
  objective: CompanyMapObjective;
  open: boolean;
  onToggle: () => void;
  openInitiatives: Set<string>;
  onToggleInitiative: (id: string) => void;
  openProjects: Set<string>;
  onToggleProject: (id: string) => void;
}) {
  return (
    <div className="tree-node">
      <div className="tree-row">
        <Toggle open={open} hasChildren={objective.initiatives.length > 0} onClick={onToggle} />
        <Link className="tree-title-link" href={`/objectives/${objective.id}`}>
          {objective.title}
        </Link>
        {objective.owner && <span className="owner-line">Owner: {objective.owner}</span>}
        <span className={`badge badge-priority-${objective.priority}`}>{objective.priority}</span>
        <span className="badge">{objective.status}</span>
        <UpdatedLine updatedAt={objective.updatedAt} />
      </div>
      {open && (
        <div className="tree-children">
          {objective.initiatives.length === 0 && <p className="tree-empty">No initiatives yet.</p>}
          {objective.initiatives.map((initiative) => (
            <InitiativeNode
              initiative={initiative}
              open={openInitiatives.has(initiative.id)}
              onToggle={() => onToggleInitiative(initiative.id)}
              openProjects={openProjects}
              onToggleProject={onToggleProject}
              key={initiative.id}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function toggleId(set: Set<string>, id: string): Set<string> {
  const next = new Set(set);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

export default function CompanyMapPage() {
  const [user, setUser] = useState<SessionUser | null | "loading">("loading");
  const [data, setData] = useState<CompanyMapResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [openObjectives, setOpenObjectives] = useState<Set<string>>(new Set());
  const [openInitiatives, setOpenInitiatives] = useState<Set<string>>(new Set());
  // Every level starts open, including projects -- a newly-approved task
  // lands inside its project's task list, and a collapsed-by-default project
  // row hid that from view entirely (looked like the map "hadn't updated"
  // even though the data was already there). Individual nodes stay
  // collapsible for when a real org's map grows large enough to need it.
  const [openProjects, setOpenProjects] = useState<Set<string>>(new Set());

  const [checkingDuplicates, setCheckingDuplicates] = useState(false);
  const [duplicateResult, setDuplicateResult] = useState<DuplicateCheckResult | null>(null);
  const [duplicateError, setDuplicateError] = useState<string | null>(null);

  const [checkingRelationships, setCheckingRelationships] = useState(false);
  const [relationshipResult, setRelationshipResult] = useState<RelationshipSuggestResult | null>(null);
  const [relationshipError, setRelationshipError] = useState<string | null>(null);

  useEffect(() => {
    fetchCurrentUser().then(setUser);
  }, []);

  async function handleCheckDuplicates() {
    setCheckingDuplicates(true);
    setDuplicateError(null);
    setDuplicateResult(null);
    try {
      const result = await checkDuplicateTasks();
      setDuplicateResult(result);
    } catch (err) {
      setDuplicateError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setCheckingDuplicates(false);
    }
  }

  async function handleSuggestRelationships() {
    setCheckingRelationships(true);
    setRelationshipError(null);
    setRelationshipResult(null);
    try {
      const result = await suggestRelationships();
      setRelationshipResult(result);
    } catch (err) {
      setRelationshipError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setCheckingRelationships(false);
    }
  }

  useEffect(() => {
    if (user && user !== "loading") {
      fetchCompanyMap()
        .then((res) => {
          setData(res);
          setOpenObjectives(new Set(res.objectives.map((o) => o.id)));
          setOpenInitiatives(new Set(res.objectives.flatMap((o) => o.initiatives.map((i) => i.id))));
          setOpenProjects(
            new Set(res.objectives.flatMap((o) => o.initiatives.flatMap((i) => i.projects.map((p) => p.id)))),
          );
        })
        .catch((err) => setLoadError(err.message));
    }
  }, [user]);

  if (user === "loading") {
    return (
      <main className="page">
        <Nav />
        <p className="muted">Loading&hellip;</p>
      </main>
    );
  }

  if (!user) {
    return (
      <main className="page">
        <Nav />
        <div className="header">
          <h1>Exvade Pulse</h1>
        </div>
        <p>Sign in with your Exvade Google account to see the company map.</p>
        <a className="signin-btn" href={`${API_URL}/auth/google`}>
          Sign in with Google
        </a>
      </main>
    );
  }

  return (
    <main className="page">
      <Nav user={user} />
      <div className="header">
        <h1>Company map</h1>
        <span className="muted">{user.email}</span>
      </div>

      <div className="card-actions" style={{ marginBottom: 16 }}>
        <button className="decision-btn" onClick={handleCheckDuplicates} disabled={checkingDuplicates}>
          {checkingDuplicates ? "Checking…" : "Check for duplicate tasks"}
        </button>
        <button className="decision-btn" onClick={handleSuggestRelationships} disabled={checkingRelationships}>
          {checkingRelationships ? "Checking…" : "Suggest relationships"}
        </button>
      </div>

      {duplicateResult && (
        <p className="card activity-summary">
          Checked {duplicateResult.tasksChecked} task{duplicateResult.tasksChecked === 1 ? "" : "s"} across{" "}
          {duplicateResult.projectsChecked} project{duplicateResult.projectsChecked === 1 ? "" : "s"} -- found{" "}
          {duplicateResult.duplicatesFound} likely duplicate{duplicateResult.duplicatesFound === 1 ? "" : "s"}.
          {duplicateResult.duplicatesFound > 0 && (
            <>
              {" "}
              <Link href="/review">Review them</Link>.
            </>
          )}
        </p>
      )}
      {duplicateError && <div className="error-banner">{duplicateError}</div>}

      {relationshipResult && (
        <p className="card activity-summary">
          Checked {relationshipResult.tasksChecked} task{relationshipResult.tasksChecked === 1 ? "" : "s"} across{" "}
          {relationshipResult.projectsChecked} project{relationshipResult.projectsChecked === 1 ? "" : "s"} -- found{" "}
          {relationshipResult.relationshipsFound} relationship{relationshipResult.relationshipsFound === 1 ? "" : "s"}.
          {relationshipResult.relationshipsFound > 0 && (
            <>
              {" "}
              <Link href="/review">Review them</Link>.
            </>
          )}
        </p>
      )}
      {relationshipError && <div className="error-banner">{relationshipError}</div>}

      {loadError && <div className="error-banner">{loadError}</div>}

      {data && data.objectives.length === 0 && !loadError && (
        <p className="empty-state">No objectives yet.</p>
      )}

      {data && data.objectives.length > 0 && (
        <div className="tree">
          {data.objectives.map((objective) => (
            <ObjectiveNode
              objective={objective}
              open={openObjectives.has(objective.id)}
              onToggle={() => setOpenObjectives((prev) => toggleId(prev, objective.id))}
              openInitiatives={openInitiatives}
              onToggleInitiative={(id) => setOpenInitiatives((prev) => toggleId(prev, id))}
              openProjects={openProjects}
              onToggleProject={(id) => setOpenProjects((prev) => toggleId(prev, id))}
              key={objective.id}
            />
          ))}
        </div>
      )}
    </main>
  );
}
