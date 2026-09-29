// Due dates are calendar dates, stored as midnight UTC. Formatting them in
// the viewer's local zone shifts them a day early in the Americas
// (Sep 21 -> Sep 20), so they're always rendered in UTC. Real moments in
// time (updated, received, approved) keep using local time.
export function formatDueDate(iso: string, style: "short" | "long" = "long"): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(style === "long" ? { year: "numeric" } : {}),
    timeZone: "UTC",
  });
}
