"use client";

import { useState } from "react";
import type { Visibility } from "../../lib/api";

const VISIBILITY_LABEL: Record<Visibility, string> = {
  team: "Team",
  leadership: "Leadership",
  restricted: "Restricted",
};

// A non-admin viewer only ever sees this rendered at all because the
// backend already let them see the entity (a restricted item is filtered
// out of every list/detail response for a member -- see
// backend/src/access/visibility.ts), so showing the current level here
// doesn't leak anything new; it's just a read-only badge for them. Only an
// admin gets the actual selector, since changing visibility is deliberately
// a human-only, admin-only action -- never something an AI suggestion can
// propose (see ALLOWED_FIELDS's comment in suggestions/apply.ts).
export function VisibilityControl({
  visibility,
  isAdmin,
  onChange,
}: {
  visibility: Visibility;
  isAdmin: boolean;
  onChange: (next: Visibility) => Promise<void>;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isAdmin) {
    return visibility === "team" ? null : <span className="badge badge-restricted">{VISIBILITY_LABEL[visibility]}</span>;
  }

  async function handleChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const next = e.target.value as Visibility;
    setSaving(true);
    setError(null);
    try {
      await onChange(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setSaving(false);
    }
  }

  return (
    <span className="visibility-control">
      <select
        className="edit-input visibility-select"
        value={visibility}
        onChange={handleChange}
        disabled={saving}
        aria-label="Visibility"
      >
        <option value="team">Team</option>
        <option value="leadership">Leadership</option>
        <option value="restricted">Restricted</option>
      </select>
      {error && <span className="error-banner">{error}</span>}
    </span>
  );
}
