"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  API_URL,
  fetchCompanyMap,
  fetchCurrentUser,
  type CompanyMapInitiative,
  type CompanyMapObjective,
  type CompanyMapProject,
  type CompanyMapResponse,
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

function TaskRow({ task }: { task: CompanyMapProject["tasks"][number] }) {
  return (
    <div className="tree-task-row">
      <Link className="tree-title-link" href={`/tasks/${task.id}`}>
        {task.title}
      </Link>
      <span className="badge">{task.status.replace("_", " ")}</span>
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
        <span className="badge">{project.status}</span>
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
        <span className={`badge badge-priority-${initiative.priority}`}>{initiative.priority}</span>
        <span className="badge">{initiative.status}</span>
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
        <span className={`badge badge-priority-${objective.priority}`}>{objective.priority}</span>
        <span className="badge">{objective.status}</span>
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
  // Projects start collapsed -- task lists are the most numerous leaf level,
  // and expanding every one by default is the case most likely to make a
  // real org's map unwieldy. Objectives/initiatives start open since seeing
  // the whole structure at once is the point of this page.
  const [openProjects, setOpenProjects] = useState<Set<string>>(new Set());

  useEffect(() => {
    fetchCurrentUser().then(setUser);
  }, []);

  useEffect(() => {
    if (user && user !== "loading") {
      fetchCompanyMap()
        .then((res) => {
          setData(res);
          setOpenObjectives(new Set(res.objectives.map((o) => o.id)));
          setOpenInitiatives(new Set(res.objectives.flatMap((o) => o.initiatives.map((i) => i.id))));
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
