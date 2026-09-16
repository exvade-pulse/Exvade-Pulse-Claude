export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

export type UserRole = "member" | "admin";

export interface SessionUser {
  userId: string;
  organizationId: string;
  email: string;
  role: UserRole;
}

export interface Suggestion {
  id: string;
  targetType: "objective" | "initiative" | "project" | "task";
  targetId: string | null;
  changeType: string;
  proposedDiff: Record<string, unknown>;
  reasoning: string;
  confidence: number;
  status: string;
  createdAt: string;
  source: {
    type: string;
    externalId: string;
    receivedAt: string;
  };
}

export async function fetchCurrentUser(): Promise<SessionUser | null> {
  const res = await fetch(`${API_URL}/auth/me`, { credentials: "include" });
  if (!res.ok) return null;
  const body = (await res.json()) as { user: SessionUser };
  return body.user;
}

// No status query param: the backend's default set is "pending" + "edited" --
// suggestions still awaiting a review decision, whether or not they've been
// hand-edited since being proposed.
export async function fetchPendingSuggestions(): Promise<Suggestion[]> {
  const res = await fetch(`${API_URL}/api/suggestions`, { credentials: "include" });
  if (!res.ok) {
    throw new Error(`Failed to load suggestions (${res.status})`);
  }
  const body = (await res.json()) as { suggestions: Suggestion[] };
  return body.suggestions;
}

export async function decideSuggestion(id: string, decision: "approve" | "reject"): Promise<void> {
  const res = await fetch(`${API_URL}/api/suggestions/${id}/${decision}`, {
    method: "POST",
    credentials: "include",
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `Failed to ${decision} suggestion`);
  }
}

export type TaskStatus =
  | "active"
  | "waiting"
  | "needs_attention"
  | "completed"
  | "superseded"
  | "resolved"
  | "blocked";

export type TaskCounts = Record<TaskStatus, number>;

export interface DashboardObjective {
  id: string;
  title: string;
  description: string | null;
  status: "active" | "paused" | "completed" | "cancelled";
  priority: "low" | "medium" | "high" | "critical";
  createdAt: string;
  updatedAt: string;
  initiativeCount: number;
  taskCounts: TaskCounts;
}

export async function fetchDashboardObjectives(): Promise<DashboardObjective[]> {
  const res = await fetch(`${API_URL}/api/dashboard/objectives`, { credentials: "include" });
  if (!res.ok) {
    throw new Error(`Failed to load dashboard (${res.status})`);
  }
  const body = (await res.json()) as { objectives: DashboardObjective[] };
  return body.objectives;
}

export async function editSuggestion(id: string, proposedDiff: Record<string, unknown>): Promise<Suggestion> {
  const res = await fetch(`${API_URL}/api/suggestions/${id}`, {
    method: "PATCH",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ proposedDiff }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? "Failed to save edit");
  }
  const body = (await res.json()) as { suggestion: Suggestion };
  return body.suggestion;
}

export interface Decision {
  id: string;
  title: string;
  whyItMatters: string | null;
  relevantContext: string | null;
  suggestedNextStep: string | null;
  decider: string;
  stakeholders: string[];
  status: "open" | "decided";
  dueDate: string | null;
  resolution: string | null;
  decidedAt: string | null;
  relatedTaskId: string | null;
  relatedTaskTitle: string | null;
  sourceId: string | null;
  createdAt: string;
  updatedAt: string;
}

// No status query param: the backend defaults to "open" -- decisions still
// awaiting a call, same default-to-active-work pattern as suggestions.
export async function fetchOpenDecisions(): Promise<Decision[]> {
  const res = await fetch(`${API_URL}/api/decisions`, { credentials: "include" });
  if (!res.ok) {
    throw new Error(`Failed to load decisions (${res.status})`);
  }
  const body = (await res.json()) as { decisions: Decision[] };
  return body.decisions;
}

export interface CreateDecisionInput {
  title: string;
  decider: string;
  stakeholders?: string[];
  dueDate?: string | null;
  whyItMatters?: string | null;
  relevantContext?: string | null;
  suggestedNextStep?: string | null;
  relatedTaskId?: string | null;
}

export async function createDecision(input: CreateDecisionInput): Promise<Decision> {
  const res = await fetch(`${API_URL}/api/decisions`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? "Failed to create decision");
  }
  const body = (await res.json()) as { decision: Decision };
  return body.decision;
}

export async function resolveDecision(id: string, resolution: string): Promise<Decision> {
  const res = await fetch(`${API_URL}/api/decisions/${id}/resolve`, {
    method: "PATCH",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ resolution }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? "Failed to resolve decision");
  }
  const body = (await res.json()) as { decision: Decision };
  return body.decision;
}

export type StrategyStatus = "active" | "paused" | "completed" | "cancelled";
export type Priority = "low" | "medium" | "high" | "critical";

export interface ObjectiveDetail {
  id: string;
  title: string;
  description: string | null;
  status: StrategyStatus;
  priority: Priority;
  createdAt: string;
  updatedAt: string;
}

export interface InitiativeSummary {
  id: string;
  title: string;
  status: StrategyStatus;
  priority: Priority;
}

export interface ObjectiveDetailResponse {
  objective: ObjectiveDetail;
  initiatives: InitiativeSummary[];
}

// A 404 is an expected, non-exceptional outcome here (stale link, bad id
// typed into the URL) -- callers render a "not found" state for it rather
// than catching a thrown error.
export async function fetchObjective(id: string): Promise<ObjectiveDetailResponse | "not_found"> {
  const res = await fetch(`${API_URL}/api/objectives/${id}`, { credentials: "include" });
  if (res.status === 404) return "not_found";
  if (!res.ok) {
    throw new Error(`Failed to load objective (${res.status})`);
  }
  return res.json();
}

export interface InitiativeDetail {
  id: string;
  title: string;
  description: string | null;
  status: StrategyStatus;
  priority: Priority;
  objectiveId: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectSummary {
  id: string;
  title: string;
  status: StrategyStatus;
}

export interface InitiativeDetailResponse {
  initiative: InitiativeDetail;
  objective: { id: string; title: string } | null;
  projects: ProjectSummary[];
}

export async function fetchInitiative(id: string): Promise<InitiativeDetailResponse | "not_found"> {
  const res = await fetch(`${API_URL}/api/initiatives/${id}`, { credentials: "include" });
  if (res.status === 404) return "not_found";
  if (!res.ok) {
    throw new Error(`Failed to load initiative (${res.status})`);
  }
  return res.json();
}

export interface ProjectDetail {
  id: string;
  title: string;
  description: string | null;
  status: StrategyStatus;
  initiativeId: string;
  createdAt: string;
  updatedAt: string;
}

export interface TaskSummary {
  id: string;
  title: string;
  status: TaskStatus;
  latestUpdate: string | null;
  nextAction: string | null;
}

export interface ProjectDetailResponse {
  project: ProjectDetail;
  initiative: { id: string; title: string } | null;
  tasks: TaskSummary[];
}

export async function fetchProject(id: string): Promise<ProjectDetailResponse | "not_found"> {
  const res = await fetch(`${API_URL}/api/projects/${id}`, { credentials: "include" });
  if (res.status === 404) return "not_found";
  if (!res.ok) {
    throw new Error(`Failed to load project (${res.status})`);
  }
  return res.json();
}

export interface TaskDetail {
  id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  latestUpdate: string | null;
  nextAction: string | null;
  projectId: string;
  createdAt: string;
  updatedAt: string;
}

export interface ApprovedTaskSuggestion {
  id: string;
  changeType: string;
  reasoning: string;
  reviewedAt: string | null;
}

export interface TaskDetailResponse {
  task: TaskDetail;
  project: { id: string; title: string } | null;
  initiative: { id: string; title: string } | null;
  objective: { id: string; title: string } | null;
  approvedSuggestions: ApprovedTaskSuggestion[];
}

export async function fetchTask(id: string): Promise<TaskDetailResponse | "not_found"> {
  const res = await fetch(`${API_URL}/api/tasks/${id}`, { credentials: "include" });
  if (res.status === 404) return "not_found";
  if (!res.ok) {
    throw new Error(`Failed to load task (${res.status})`);
  }
  return res.json();
}

export interface AuthorizedUser {
  email: string;
  role: UserRole;
  createdAt: string;
  name: string | null;
  hasSignedIn: boolean;
}

// A 403 here (non-admin hitting an admin-only route) is expected and handled
// by the caller -- not thrown as an error -- so the /users page can render a
// clean "not authorized" state instead of a raw error dump.
export async function fetchAuthorizedUsers(): Promise<AuthorizedUser[] | "forbidden"> {
  const res = await fetch(`${API_URL}/api/users`, { credentials: "include" });
  if (res.status === 403) return "forbidden";
  if (!res.ok) {
    throw new Error(`Failed to load users (${res.status})`);
  }
  const body = (await res.json()) as { users: AuthorizedUser[] };
  return body.users;
}

export async function authorizeUser(email: string, role: UserRole): Promise<void> {
  const res = await fetch(`${API_URL}/api/users`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, role }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? "Failed to authorize user");
  }
}

export async function changeUserRole(email: string, role: UserRole): Promise<void> {
  const res = await fetch(`${API_URL}/api/users/${encodeURIComponent(email)}/role`, {
    method: "PATCH",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ role }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? "Failed to change role");
  }
}

export type IntegrationType = "circleback";

export interface IntegrationStatus {
  type: IntegrationType;
  configured: boolean;
  createdAt: string | null;
  lastReceivedAt: string | null;
}

export interface GeneratedIntegrationToken {
  type: IntegrationType;
  token: string;
  webhookUrl: string;
  rotated: boolean;
  createdAt: string;
  lastReceivedAt: string | null;
}

export async function fetchIntegrations(): Promise<IntegrationStatus[] | "forbidden"> {
  const res = await fetch(`${API_URL}/api/integrations`, { credentials: "include" });
  if (res.status === 403) return "forbidden";
  if (!res.ok) {
    throw new Error(`Failed to load integrations (${res.status})`);
  }
  const body = (await res.json()) as { integrations: IntegrationStatus[] };
  return body.integrations;
}

export async function generateIntegrationToken(type: IntegrationType): Promise<GeneratedIntegrationToken> {
  const res = await fetch(`${API_URL}/api/integrations/${type}/token`, {
    method: "POST",
    credentials: "include",
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? "Failed to generate token");
  }
  return res.json();
}

export interface ActivityEntry {
  id: string;
  action: string;
  entityType: string;
  entityId: string | null;
  details: Record<string, unknown> | null;
  createdAt: string;
  actorName: string | null;
  actorEmail: string | null;
}

export async function fetchActivity(): Promise<ActivityEntry[]> {
  const res = await fetch(`${API_URL}/api/activity`, { credentials: "include" });
  if (!res.ok) {
    throw new Error(`Failed to load activity (${res.status})`);
  }
  const body = (await res.json()) as { entries: ActivityEntry[] };
  return body.entries;
}

export async function revokeUser(email: string): Promise<void> {
  const res = await fetch(`${API_URL}/api/users/${encodeURIComponent(email)}`, {
    method: "DELETE",
    credentials: "include",
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? "Failed to revoke user");
  }
}
