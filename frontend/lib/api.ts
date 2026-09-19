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
  targetType: "objective" | "initiative" | "project" | "task" | "decision";
  targetId: string | null;
  changeType: string;
  proposedDiff: Record<string, unknown>;
  reasoning: string;
  confidence: number;
  status: string;
  createdAt: string;
  reviewedAt: string | null;
  reviewerName: string | null;
  reviewerEmail: string | null;
  source: {
    id: string;
    type: string;
    externalId: string;
    receivedAt: string;
  };
  // The live target row's values for exactly the fields proposedDiff touches
  // -- null for a brand-new entity (targetId null), or if the target can't
  // be resolved. Lets the review card show "current -> proposed" instead of
  // just the proposed value in isolation.
  currentState: Record<string, unknown> | null;
  // Where this suggestion's target lives in the objective/initiative/project
  // hierarchy (the levels *above* it) -- null when the target is an
  // objective itself, a decision, or a level that couldn't be resolved (e.g.
  // a brand-new entity proposed with no parent id yet).
  breadcrumb: {
    objective?: { id: string; title: string };
    initiative?: { id: string; title: string };
    project?: { id: string; title: string };
  } | null;
  // Set only when this suggestion proposes moving an existing task to a
  // *different* project than the one it's currently in (the Unsorted
  // re-triage flow is the only producer of this today). The plain diff view
  // hides projectId entirely, so this is the only visual sign of the move.
  movingToProject: { id: string; title: string } | null;
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

// An explicit status narrows to exactly that status (see backend/src/routes/suggestions.ts) --
// used for the review page's history view (approved/rejected), as opposed to
// fetchPendingSuggestions's fixed pending+edited default.
export async function fetchSuggestionsByStatus(status: "approved" | "rejected"): Promise<Suggestion[]> {
  const res = await fetch(`${API_URL}/api/suggestions?status=${status}`, { credentials: "include" });
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

export interface BulkApproveResult {
  approved: string[];
  failed: Array<{ id: string; error: string }>;
}

// One request for several approvals at once, for the review queue's "approve
// all ready-to-approve" action -- see backend/src/routes/suggestions.ts for
// why this is a dedicated endpoint rather than N calls to decideSuggestion.
export async function bulkApproveSuggestions(ids: string[]): Promise<BulkApproveResult> {
  const res = await fetch(`${API_URL}/api/suggestions/bulk-approve`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? "Failed to bulk-approve suggestions");
  }
  return res.json();
}

export interface SourceDetail {
  id: string;
  type: string;
  externalId: string;
  receivedAt: string;
  rawBody: string | null;
}

// Deliberately separate from fetchPendingSuggestions/fetchOpenDecisions:
// rawBody can be a full email/meeting/document and is usually never read, so
// it's fetched lazily only when a "View source" toggle is actually opened,
// not bundled into every suggestion/decision list response.
export async function fetchSource(id: string): Promise<SourceDetail> {
  const res = await fetch(`${API_URL}/api/sources/${id}`, { credentials: "include" });
  if (!res.ok) {
    throw new Error(`Failed to load source (${res.status})`);
  }
  const body = (await res.json()) as { source: SourceDetail };
  return body.source;
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
  owner: string | null;
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

export async function fetchStatusSummary(): Promise<TaskCounts> {
  const res = await fetch(`${API_URL}/api/dashboard/status-summary`, { credentials: "include" });
  if (!res.ok) {
    throw new Error(`Failed to load status summary (${res.status})`);
  }
  const body = (await res.json()) as { taskCounts: TaskCounts };
  return body.taskCounts;
}

export interface DashboardTaskChainEntry {
  id: string;
  title: string;
}

// The open decision actually blocking a task, if any -- the "why is this
// stuck" answer that a bare status chip can't show on its own.
export interface BlockingDecision {
  id: string;
  title: string;
}

// The task-centric shape shared by needs-attention and recent-progress: a
// lighter-weight parent chain (id/title only, no owner/status) than
// fetchTask's full TaskDetailResponse, since these lists render many tasks
// at once rather than one task's full page.
export interface DashboardTask {
  id: string;
  title: string;
  status: TaskStatus;
  owner: string | null;
  latestUpdate: string | null;
  nextAction: string | null;
  updatedAt: string;
  project: DashboardTaskChainEntry;
  initiative: DashboardTaskChainEntry;
  objective: DashboardTaskChainEntry;
  // Only ever present on needs-attention rows (recent-progress tasks are
  // completed/resolved, never blocked, so that endpoint doesn't compute this).
  blockingDecision?: BlockingDecision | null;
  // All-time count of approved suggestions citing this task -- see
  // backend/src/tasks/sourceCounts.ts.
  sourceCount: number;
}

export async function fetchNeedsAttention(): Promise<DashboardTask[]> {
  const res = await fetch(`${API_URL}/api/dashboard/needs-attention`, { credentials: "include" });
  if (!res.ok) {
    throw new Error(`Failed to load needs-attention tasks (${res.status})`);
  }
  const body = (await res.json()) as { tasks: DashboardTask[] };
  return body.tasks;
}

export async function fetchRecentProgress(): Promise<DashboardTask[]> {
  const res = await fetch(`${API_URL}/api/dashboard/recent-progress`, { credentials: "include" });
  if (!res.ok) {
    throw new Error(`Failed to load recent progress (${res.status})`);
  }
  const body = (await res.json()) as { tasks: DashboardTask[] };
  return body.tasks;
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

// "leadership" and "restricted" both currently gate on the admin role --
// this app has exactly two roles, so there's no distinct enforcement tier
// between them yet (see backend/src/access/visibility.ts).
export type Visibility = "team" | "leadership" | "restricted";

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
  // Lets the resolve UI decide whether "also unblock this task" is a
  // relevant option to offer without a second fetch per decision.
  relatedTaskStatus: TaskStatus | null;
  sourceId: string | null;
  visibility: Visibility;
  createdAt: string;
  updatedAt: string;
}

export async function setDecisionVisibility(id: string, visibility: Visibility): Promise<void> {
  const res = await fetch(`${API_URL}/api/decisions/${id}/visibility`, {
    method: "PATCH",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ visibility }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? "Failed to change visibility");
  }
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

export interface ResolveDecisionResult {
  decision: Decision;
  // Non-null only when alsoUnblockTask was true, the decision had a
  // relatedTaskId, and that task was actually blocked -- see
  // backend/src/decisions/manage.ts's resolveDecision.
  unblockedTask: { id: string; status: TaskStatus } | null;
}

export async function addDecisionInfo(id: string, note: string): Promise<Decision> {
  const res = await fetch(`${API_URL}/api/decisions/${id}/add-info`, {
    method: "PATCH",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ note }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? "Failed to add information");
  }
  const body = (await res.json()) as { decision: Decision };
  return body.decision;
}

export async function assignDecision(id: string, decider: string): Promise<Decision> {
  const res = await fetch(`${API_URL}/api/decisions/${id}/assign`, {
    method: "PATCH",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ decider }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? "Failed to assign decision");
  }
  const body = (await res.json()) as { decision: Decision };
  return body.decision;
}

export async function resolveDecision(
  id: string,
  resolution: string,
  alsoUnblockTask = false,
): Promise<ResolveDecisionResult> {
  const res = await fetch(`${API_URL}/api/decisions/${id}/resolve`, {
    method: "PATCH",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ resolution, alsoUnblockTask }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? "Failed to resolve decision");
  }
  return res.json();
}

export type StrategyStatus = "active" | "paused" | "completed" | "cancelled";
export type Priority = "low" | "medium" | "high" | "critical";

export interface ObjectiveDetail {
  id: string;
  title: string;
  description: string | null;
  status: StrategyStatus;
  priority: Priority;
  owner: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface InitiativeSummary {
  id: string;
  title: string;
  status: StrategyStatus;
  priority: Priority;
  owner: string | null;
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
  owner: string | null;
  objectiveId: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectSummary {
  id: string;
  title: string;
  status: StrategyStatus;
  owner: string | null;
}

export interface InitiativeDetailResponse {
  initiative: InitiativeDetail;
  objective: { id: string; title: string } | null;
  projects: ProjectSummary[];
  taskCounts: TaskCounts;
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
  owner: string | null;
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
  owner: string | null;
}

export interface ProjectDetailResponse {
  project: ProjectDetail;
  initiative: { id: string; title: string } | null;
  tasks: TaskSummary[];
  taskCounts: TaskCounts;
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
  owner: string | null;
  projectId: string;
  visibility: Visibility;
  createdAt: string;
  updatedAt: string;
}

export async function setTaskVisibility(id: string, visibility: Visibility): Promise<void> {
  const res = await fetch(`${API_URL}/api/tasks/${id}/visibility`, {
    method: "PATCH",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ visibility }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? "Failed to change visibility");
  }
}

export interface ApprovedTaskSuggestion {
  id: string;
  changeType: string;
  reasoning: string;
  proposedDiff: Record<string, unknown>;
  reviewedAt: string | null;
}

export interface TaskDetailResponse {
  task: TaskDetail;
  project: { id: string; title: string } | null;
  initiative: { id: string; title: string } | null;
  objective: { id: string; title: string } | null;
  approvedSuggestions: ApprovedTaskSuggestion[];
  blockingDecision: BlockingDecision | null;
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

export type IntegrationType = "circleback" | "email";

export interface IntegrationStatus {
  type: IntegrationType;
  configured: boolean;
  createdAt: string | null;
  lastReceivedAt: string | null;
  totalSuggestions: number;
}

export interface GeneratedIntegrationToken {
  type: IntegrationType;
  token: string;
  webhookUrl: string;
  rotated: boolean;
  createdAt: string;
  lastReceivedAt: string | null;
}

export interface GmailConnectionStatus {
  connected: boolean;
  emailAddress: string | null;
  connectedAt: string | null;
  lastSyncedAt: string | null;
  lastSyncError: string | null;
  totalSuggestions: number;
}

export interface GmailSyncResult {
  messagesFound: number;
  suggestionsCreated: number;
  errors: number;
}

export async function fetchIntegrations(): Promise<{ integrations: IntegrationStatus[]; gmail: GmailConnectionStatus } | "forbidden"> {
  const res = await fetch(`${API_URL}/api/integrations`, { credentials: "include" });
  if (res.status === 403) return "forbidden";
  if (!res.ok) {
    throw new Error(`Failed to load integrations (${res.status})`);
  }
  return res.json();
}

export async function triggerGmailSync(): Promise<GmailSyncResult> {
  const res = await fetch(`${API_URL}/api/integrations/gmail/sync`, { method: "POST", credentials: "include" });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? "Gmail sync failed");
  }
  return res.json();
}

export async function disconnectGmail(): Promise<void> {
  const res = await fetch(`${API_URL}/api/integrations/gmail`, { method: "DELETE", credentials: "include" });
  if (!res.ok) {
    throw new Error(`Failed to disconnect Gmail (${res.status})`);
  }
}

export interface IntegrationActivityItem {
  id: string;
  externalId: string;
  receivedAt: string;
  suggestionCount: number;
}

export async function fetchIntegrationActivity(type: IntegrationType): Promise<IntegrationActivityItem[]> {
  const res = await fetch(`${API_URL}/api/integrations/${type}/activity`, { credentials: "include" });
  if (!res.ok) {
    throw new Error(`Failed to load ${type} activity (${res.status})`);
  }
  const body = (await res.json()) as { activity: IntegrationActivityItem[] };
  return body.activity;
}

// Not IntegrationType-parameterized like the function above -- "gmail" is a
// real connection (gmailConnections), not a webhookIntegrations row, so it
// has its own route even though the underlying activity query is identical.
export async function fetchGmailActivity(): Promise<IntegrationActivityItem[]> {
  const res = await fetch(`${API_URL}/api/integrations/gmail/activity`, { credentials: "include" });
  if (!res.ok) {
    throw new Error(`Failed to load Gmail activity (${res.status})`);
  }
  const body = (await res.json()) as { activity: IntegrationActivityItem[] };
  return body.activity;
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

export interface ActivitySummaryDecision {
  id: string;
  title: string;
}

// Structured counts, not a pre-formatted sentence -- wording is a frontend
// concern (see activity/page.tsx's buildSummarySentence), this is just data.
export interface ActivitySummary {
  statusMoves: number;
  completions: number;
  newDecisions: number;
  openDecisionsCount: number;
  mostUrgentOpenDecision: ActivitySummaryDecision | null;
}

export interface ActivityResponse {
  entries: ActivityEntry[];
  // The caller's lastActivityViewAt as it stood BEFORE this request (which
  // itself just advanced it to now) -- null on a user's first-ever visit.
  previousLastActivityViewAt: string | null;
  summary: ActivitySummary;
}

export async function fetchActivity(): Promise<ActivityResponse> {
  const res = await fetch(`${API_URL}/api/activity`, { credentials: "include" });
  if (!res.ok) {
    throw new Error(`Failed to load activity (${res.status})`);
  }
  return res.json();
}

// A separate mutation from fetchActivity on purpose -- call this once per
// genuine page visit (guarded against StrictMode's double-invoke by the
// caller), never as a side effect of the read itself.
export async function markActivityVisited(): Promise<void> {
  await fetch(`${API_URL}/api/activity/mark-visited`, { method: "POST", credentials: "include" });
}

export interface CompanyMapTask {
  id: string;
  title: string;
  status: TaskStatus;
  latestUpdate: string | null;
  nextAction: string | null;
  owner: string | null;
  sourceCount: number;
  blockingDecision: BlockingDecision | null;
}

export interface CompanyMapProject {
  id: string;
  title: string;
  status: StrategyStatus;
  owner: string | null;
  tasks: CompanyMapTask[];
}

export interface CompanyMapInitiative {
  id: string;
  title: string;
  status: StrategyStatus;
  priority: Priority;
  owner: string | null;
  projects: CompanyMapProject[];
}

export interface CompanyMapObjective {
  id: string;
  title: string;
  description: string | null;
  status: StrategyStatus;
  priority: Priority;
  owner: string | null;
  initiatives: CompanyMapInitiative[];
}

export interface CompanyMapResponse {
  objectives: CompanyMapObjective[];
}

// The whole Objective -> Initiative -> Project -> Task tree in one call, for
// the Company Map overview page -- distinct from fetchObjective/fetchInitiative/
// fetchProject/fetchTask, which each fetch one node plus its immediate
// children for a drill-down detail page.
export async function fetchCompanyMap(): Promise<CompanyMapResponse> {
  const res = await fetch(`${API_URL}/api/company-map`, { credentials: "include" });
  if (!res.ok) {
    throw new Error(`Failed to load company map (${res.status})`);
  }
  return res.json();
}

export interface UnsortedTask {
  id: string;
  title: string;
  status: TaskStatus;
  latestUpdate: string | null;
  nextAction: string | null;
  owner: string | null;
  // Set when a re-triage pass (or any other suggestion) already proposed
  // something for this task and it's still awaiting a review decision.
  pendingSuggestion: { confidence: number } | null;
}

export interface UnsortedResponse {
  project: { id: string; title: string } | null;
  tasks: UnsortedTask[];
}

// One-click flat view of the "Unsorted / Needs Triage" catch-all -- the
// alternative (Company Map, several nested expand-clicks deep to reach one
// project's task list) is exactly the friction this page exists to remove.
export async function fetchUnsorted(): Promise<UnsortedResponse> {
  const res = await fetch(`${API_URL}/api/unsorted`, { credentials: "include" });
  if (!res.ok) {
    throw new Error(`Failed to load Unsorted tasks (${res.status})`);
  }
  return res.json();
}

export interface RetriageResult {
  checked: number;
  suggested: number;
}

// Triggers an on-demand Claude pass (one call per eligible Unsorted task)
// that proposes moving each one to a real project, if a clear match exists.
// Never runs automatically -- see backend/src/routes/unsorted.ts.
export async function triggerUnsortedRetriage(): Promise<RetriageResult> {
  const res = await fetch(`${API_URL}/api/unsorted/retriage`, { method: "POST", credentials: "include" });
  if (!res.ok) {
    throw new Error(`Failed to re-triage Unsorted tasks (${res.status})`);
  }
  return res.json();
}

export interface DuplicateCheckResult {
  projectsChecked: number;
  tasksChecked: number;
  duplicatesFound: number;
}

// Triggers an on-demand Claude pass (one call per project with 2+ open
// tasks) that flags genuine duplicate tasks -- any found pair proposes
// marking the lesser copy "superseded" as a normal suggestion in Review.
// Never runs automatically -- see backend/src/routes/duplicates.ts.
export async function checkDuplicateTasks(): Promise<DuplicateCheckResult> {
  const res = await fetch(`${API_URL}/api/tasks/check-duplicates`, { method: "POST", credentials: "include" });
  if (!res.ok) {
    throw new Error(`Failed to check for duplicate tasks (${res.status})`);
  }
  return res.json();
}

export interface WeeklyReportDecision {
  id: string;
  title: string;
  decider: string;
  dueDate: string | null;
}

export interface WeeklyReportParentChainEntry {
  id: string;
  title: string;
}

export interface WeeklyReportBlocker {
  id: string;
  title: string;
  owner: string | null;
  project: WeeklyReportParentChainEntry;
  initiative: WeeklyReportParentChainEntry;
  objective: WeeklyReportParentChainEntry;
}

export interface WeeklyReportTask {
  id: string;
  title: string;
  owner: string | null;
  latestUpdate: string | null;
  nextAction: string | null;
  sourceCount: number;
}

export interface WeeklyReportWorkstream {
  objectiveId: string;
  objectiveTitle: string;
  tasks: WeeklyReportTask[];
}

export interface WeeklyReportSource {
  id: string;
  type: string;
  externalId: string;
  receivedAt: string;
}

export interface WeeklyReport {
  weekStart: string;
  weekEnd: string;
  decisionsNeeded: WeeklyReportDecision[];
  blockers: WeeklyReportBlocker[];
  workstreams: WeeklyReportWorkstream[];
  sources: WeeklyReportSource[];
  taskCount: number;
}

// weekOf is any date (YYYY-MM-DD) inside the target week -- the backend
// resolves it to that week's Monday-Sunday range (see
// backend/src/routes/reports.ts's computeWeekRange). Omitted, it defaults to
// the current week.
export async function fetchWeeklyReport(weekOf?: string): Promise<WeeklyReport> {
  const url = weekOf ? `${API_URL}/api/reports/weekly?weekOf=${weekOf}` : `${API_URL}/api/reports/weekly`;
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) {
    throw new Error(`Failed to load weekly report (${res.status})`);
  }
  return res.json();
}

export interface ManualUpdateResult {
  sourceId: string;
  suggestionIds: string[];
  skippedAsNoise: boolean;
}

// Feeds a typed note through the exact same redaction -> noise-filter ->
// interpretation pipeline as email/Circleback/document ingestion (see
// backend/src/routes/sources.ts) -- a direct-entry alternative to those, not
// a shortcut that skips review.
export async function submitManualUpdate(note: string): Promise<ManualUpdateResult> {
  const res = await fetch(`${API_URL}/api/sources/manual`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ note }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? "Failed to submit update");
  }
  return res.json();
}

export interface SearchParentChainEntry {
  id: string;
  title: string;
}

export interface SearchObjectiveResult {
  id: string;
  title: string;
  status: StrategyStatus;
  owner: string | null;
}

export interface SearchInitiativeResult {
  id: string;
  title: string;
  status: StrategyStatus;
  owner: string | null;
  objective: SearchParentChainEntry;
}

export interface SearchProjectResult {
  id: string;
  title: string;
  status: StrategyStatus;
  owner: string | null;
  initiative: SearchParentChainEntry;
}

export interface SearchTaskResult {
  id: string;
  title: string;
  status: TaskStatus;
  owner: string | null;
  latestUpdate: string | null;
  nextAction: string | null;
  project: SearchParentChainEntry;
  initiative: SearchParentChainEntry;
  objective: SearchParentChainEntry;
}

export interface SearchDecisionResult {
  id: string;
  title: string;
  status: "open" | "decided";
  decider: string;
}

export interface SearchResponse {
  objectives: SearchObjectiveResult[];
  initiatives: SearchInitiativeResult[];
  projects: SearchProjectResult[];
  tasks: SearchTaskResult[];
  decisions: SearchDecisionResult[];
}

export async function fetchSearch(q: string): Promise<SearchResponse> {
  const res = await fetch(`${API_URL}/api/search?q=${encodeURIComponent(q)}`, { credentials: "include" });
  if (!res.ok) {
    throw new Error(`Search failed (${res.status})`);
  }
  return res.json();
}

export type EntityNodeType = "objective" | "initiative" | "project" | "task" | "decision" | "company_entity";

export const RELATION_TYPES = [
  "depends_on",
  "blocks",
  "informs",
  "affects",
  "part_of",
  "funded_by",
  "performed_by",
  "awaiting_response_from",
  "coupled_with",
  "constrains",
] as const;
export type RelationType = (typeof RELATION_TYPES)[number];

export interface CompanyEntity {
  id: string;
  name: string;
  kind: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export async function fetchCompanyEntities(): Promise<CompanyEntity[]> {
  const res = await fetch(`${API_URL}/api/company-entities`, { credentials: "include" });
  if (!res.ok) {
    throw new Error(`Failed to load company entities (${res.status})`);
  }
  const body = (await res.json()) as { entities: CompanyEntity[] };
  return body.entities;
}

export interface CreateCompanyEntityInput {
  name: string;
  kind?: string | null;
  notes?: string | null;
}

export async function createCompanyEntity(input: CreateCompanyEntityInput): Promise<CompanyEntity> {
  const res = await fetch(`${API_URL}/api/company-entities`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? "Failed to create company entity");
  }
  const body = (await res.json()) as { entity: CompanyEntity };
  return body.entity;
}

export interface EntityRelationship {
  id: string;
  relationType: RelationType;
  direction: "outgoing" | "incoming";
  otherType: EntityNodeType;
  otherId: string;
  otherName: string;
  note: string | null;
  createdAt: string;
}

export async function fetchRelationships(entityType: EntityNodeType, entityId: string): Promise<EntityRelationship[]> {
  const res = await fetch(`${API_URL}/api/relationships?entityType=${entityType}&entityId=${entityId}`, {
    credentials: "include",
  });
  if (!res.ok) {
    throw new Error(`Failed to load relationships (${res.status})`);
  }
  const body = (await res.json()) as { relationships: EntityRelationship[] };
  return body.relationships;
}

export interface CreateRelationshipInput {
  fromType: EntityNodeType;
  fromId: string;
  toType: EntityNodeType;
  toId: string;
  relationType: RelationType;
  note?: string | null;
}

export async function createRelationship(input: CreateRelationshipInput): Promise<void> {
  const res = await fetch(`${API_URL}/api/relationships`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? "Failed to create relationship");
  }
}

export async function deleteRelationship(id: string): Promise<void> {
  const res = await fetch(`${API_URL}/api/relationships/${id}`, {
    method: "DELETE",
    credentials: "include",
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? "Failed to delete relationship");
  }
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
