export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

export interface SessionUser {
  userId: string;
  organizationId: string;
  email: string;
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
