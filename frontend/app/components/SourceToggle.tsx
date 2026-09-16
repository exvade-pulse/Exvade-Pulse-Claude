"use client";

import { useState } from "react";
import { fetchSource } from "../../lib/api";

// A plain <details>/<summary> instead of a custom dropdown -- collapsed by
// default (per the source content, this needs to stay genuinely secondary,
// not compete with a card's title/reasoning/diff), zero extra state to wire
// up for open/close, and the rawBody itself is only fetched lazily on the
// first open rather than bundled into the suggestion/decision list response.
export function SourceToggle({ sourceId }: { sourceId: string }) {
  const [body, setBody] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "loaded" | "error">("idle");

  function handleToggle(e: React.SyntheticEvent<HTMLDetailsElement>) {
    if (!e.currentTarget.open || status !== "idle") return;
    setStatus("loading");
    fetchSource(sourceId)
      .then((source) => {
        setBody(source.rawBody);
        setStatus("loaded");
      })
      .catch(() => setStatus("error"));
  }

  return (
    <details className="source-toggle" onToggle={handleToggle}>
      <summary>View source</summary>
      {status === "loading" && <p className="muted">Loading&hellip;</p>}
      {status === "error" && <p className="muted">Failed to load source.</p>}
      {status === "loaded" && <pre className="source-body">{body ?? "No content available."}</pre>}
    </details>
  );
}
