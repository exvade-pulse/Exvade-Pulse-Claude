import { API_URL } from "./api";

// Types and calls for the Executive Overview (backend: routes/overview.ts,
// reports/executiveOverview.ts, overview/manage.ts, overview/reporting.ts).

export type Health = "on_track" | "at_risk" | "blocked" | "not_assessed";
export type Trend = "improving" | "stable" | "worsening" | "no_history";
export type Confidence = "committed" | "forecast" | "unconfirmed";
export type MilestoneState = "planned" | "achieved" | "missed" | "dropped";

export interface Outcome {
  id: string;
  title: string;
  rationale: string | null;
  owner: string | null;
  health: Health;
  healthRationale: string | null;
  assessedAt: string | null;
  assessedBy: string | null;
  assessmentAgeDays: number | null;
  stale: boolean;
  trend: Trend;
  signals: string[];
  assessmentMayBeOutdated: boolean;
  nextMilestone: { id: string; title: string; date: string | null; confidence: Confidence; daysAway: number | null } | null;
  undatedMilestones: number;
  openRisks: number;
  decisionsNeeded: number;
}

export interface AttentionItem {
  kind: "decision" | "blocker" | "deterioration" | "assessment_outdated" | "milestone_soon";
  tier: number;
  title: string;
  detail: string;
  objectiveId: string | null;
  date: string | null;
  daysAway: number | null;
  link: { type: "decision" | "task" | "objective" | "milestone"; id: string };
  decider?: string;
  recommendation?: string | null;
  impactOfDelay?: string | null;
}

export interface RoadmapMilestone {
  id: string;
  objectiveId: string;
  title: string;
  owner: string | null;
  date: string | null;
  baselineDate: string | null;
  forecastDate: string | null;
  actualDate: string | null;
  confidence: Confidence;
  state: MilestoneState;
  slipDays: number | null;
}

export interface OverviewRisk {
  id: string;
  objectiveId: string;
  milestoneId: string | null;
  milestoneTitle: string | null;
  title: string;
  impact: string | null;
  mitigation: string | null;
  owner: string | null;
  escalation: "watching" | "decision_needed";
  nextReviewAt: string | null;
}

export interface ExecutiveOverview {
  asOf: string;
  period: { publishedAt: string; periodStart: string; periodEnd: string } | null;
  narrative: string | null;
  outcomes: Outcome[];
  attention: AttentionItem[];
  attentionTotal: number;
  roadmap: { scheduled: RoadmapMilestone[]; unscheduled: RoadmapMilestone[] };
  changes: Array<{ kind: "health" | "milestone_date" | "milestone_state"; title: string; before: string | null; after: string | null; objectiveId: string | null }> | null;
  topRisks: OverviewRisk[];
  openRiskTotal: number;
}

export interface MilestoneDetail {
  id: string;
  objectiveId: string;
  title: string;
  successCriteria: string | null;
  owner: string | null;
  baselineDate: string | null;
  forecastDate: string | null;
  actualDate: string | null;
  confidence: Confidence;
  state: MilestoneState;
  links: Array<{ id: string; entityType: "task" | "decision" | "project"; entityId: string; title: string; status: string }>;
}

export interface RiskDetail {
  id: string;
  objectiveId: string;
  milestoneId: string | null;
  title: string;
  impact: string | null;
  likelihood: string | null;
  mitigation: string | null;
  owner: string | null;
  nextReviewAt: string | null;
  escalation: "watching" | "decision_needed";
  status: "open" | "closed";
}

export interface OutcomeDetail {
  objective: {
    id: string;
    title: string;
    description: string | null;
    rationale: string | null;
    owner: string | null;
    status: string;
    health: Health;
    healthRationale: string | null;
    healthAssessedAt: string | null;
    healthAssessedBy: string | null;
    displayOrder: number | null;
  };
  history: Array<{ id: string; health: Health; rationale: string | null; assessedAt: string; assessedBy: string | null; overrideReason: string | null; reviewBy: string | null }>;
  milestones: MilestoneDetail[];
  risks: RiskDetail[];
  decisions: Array<{ id: string; title: string; status: string; decider: string; dueDate: string | null; recommendation: string | null; impactOfDelay: string | null; undecided: boolean }>;
  questions: Array<{ id: string; title: string; label: string | null; status: string; nextAction: string | null }>;
  work: Array<{ id: string; title: string; projects: Array<{ id: string; title: string; openTasks: number }> }>;
  openTaskTotal: number;
  blockedTasks: Array<{ id: string; title: string }>;
}

async function request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    credentials: "include",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(err?.error ?? `Request failed (${res.status})`);
  }
  return res.json();
}

export const fetchOverview = () => request<ExecutiveOverview>("/api/overview");
export const fetchOutcome = (id: string) => request<OutcomeDetail>(`/api/overview/outcomes/${id}`);
export const setHealth = (id: string, body: { health: Health; rationale: string; overrideReason?: string | null; reviewBy?: string | null }) =>
  request(`/api/objectives/${id}/health`, "PUT", body);
export const updateOutcome = (id: string, body: { rationale?: string | null; owner?: string | null; displayOrder?: number | null }) =>
  request(`/api/objectives/${id}/overview`, "PATCH", body);
export const createMilestone = (body: Record<string, unknown>) => request<{ milestone: MilestoneDetail }>("/api/milestones", "POST", body);
export const updateMilestone = (id: string, body: Record<string, unknown>) => request<{ milestone: MilestoneDetail }>(`/api/milestones/${id}`, "PATCH", body);
export const linkMilestone = (id: string, body: { entityType: "task" | "decision" | "project"; entityId: string }) => request(`/api/milestones/${id}/links`, "POST", body);
export const unlinkMilestone = (id: string, linkId: string) => request(`/api/milestones/${id}/links/${linkId}`, "DELETE");
export const createRisk = (body: Record<string, unknown>) => request("/api/risks", "POST", body);
export const updateRisk = (id: string, body: Record<string, unknown>) => request(`/api/risks/${id}`, "PATCH", body);
export const updateDecisionOverview = (id: string, body: { objectiveId?: string | null; recommendation?: string | null; impactOfDelay?: string | null }) =>
  request(`/api/decisions/${id}/overview`, "PATCH", body);
export const draftNarrative = () => request<{ draft: string }>("/api/overview/draft-narrative", "POST");
export const publishOverview = (narrative: string) => request("/api/overview/publish", "POST", { narrative });

export const HEALTH_LABEL: Record<Health, string> = { on_track: "On track", at_risk: "At risk", blocked: "Blocked", not_assessed: "Not assessed" };
export const HEALTH_ICON: Record<Health, string> = { on_track: "✓", at_risk: "▲", blocked: "✕", not_assessed: "○" };
export const TREND_LABEL: Record<Trend, string> = { improving: "↗ Improving", stable: "→ Stable", worsening: "↘ Worsening", no_history: "No trend yet" };

// "2026-11-04" → "Nov 4, 2026" without a timezone shift.
export function formatDay(iso: string | null): string {
  if (!iso) return "";
  return new Date(`${iso.slice(0, 10)}T00:00:00.000Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}
