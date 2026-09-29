// Passes /api/* and /auth/* through to the Pulse server, so the browser only
// ever talks to this site's own domain. That keeps the session cookie
// first-party: Safari, Incognito, Brave and strict Firefox block cookies set
// by a different site (the server's), which made sign-in loop back to the
// sign-in page. A route handler (not a next.config rewrite) because Vercel
// rewrites give up after 2 minutes and some AI checks run longer.

// Hop-by-hop or re-computed headers that mustn't be copied across.
const SKIP_REQUEST = new Set(["host", "connection", "keep-alive", "content-length", "accept-encoding", "upgrade", "transfer-encoding"]);
const SKIP_RESPONSE = new Set(["connection", "keep-alive", "content-length", "content-encoding", "transfer-encoding", "set-cookie"]);

function backendOrigin(): string {
  // || not ??: on Vercel these can arrive as "" in a route handler.
  const configured = process.env.BACKEND_URL || process.env.NEXT_PUBLIC_API_URL;
  return (configured || (process.env.VERCEL ? "https://exvade-pulse-claude.onrender.com" : "http://localhost:3001")).replace(/\/$/, "");
}

export async function proxyToBackend(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const headers = new Headers();
  request.headers.forEach((value, key) => {
    if (!SKIP_REQUEST.has(key)) headers.set(key, value);
  });
  headers.set("x-forwarded-host", url.host);
  headers.set("x-forwarded-proto", url.protocol.replace(":", ""));
  // Tells the server to route Google sign-in back through this site.
  headers.set("x-pulse-proxy", "1");

  let upstream: Response;
  try {
    upstream = await fetch(`${backendOrigin()}${url.pathname}${url.search}`, {
      method: request.method,
      headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer(),
      redirect: "manual",
      cache: "no-store",
    });
  } catch (err) {
    const cause = (err as { cause?: { code?: string; message?: string } })?.cause;
    console.error("Backend proxy fetch failed", backendOrigin(), err, cause);
    return Response.json(
      { error: "Pulse's server couldn't be reached. Try again in a minute.", detail: `${(err as Error)?.message ?? err} ${cause?.code ?? ""} ${cause?.message ?? ""}`.trim(), target: JSON.stringify(backendOrigin()) },
      { status: 502 },
    );
  }

  const out = new Headers();
  upstream.headers.forEach((value, key) => {
    if (!SKIP_RESPONSE.has(key)) out.set(key, value);
  });
  for (const cookie of upstream.headers.getSetCookie()) out.append("set-cookie", cookie);
  const noBody = upstream.status === 204 || upstream.status === 304 || request.method === "HEAD";
  return new Response(noBody ? null : upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: out });
}
