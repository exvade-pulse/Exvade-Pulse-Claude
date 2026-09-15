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

export async function fetchPendingSuggestions(): Promise<Suggestion[]> {
  const res = await fetch(`${API_URL}/api/suggestions?status=pending`, { credentials: "include" });
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
