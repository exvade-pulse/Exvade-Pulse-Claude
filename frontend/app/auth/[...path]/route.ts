import { proxyToBackend } from "../../../lib/backendProxy";

// Every request goes to the server fresh; the longest AI checks need minutes.
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export const GET = proxyToBackend;
export const POST = proxyToBackend;
export const PUT = proxyToBackend;
export const PATCH = proxyToBackend;
export const DELETE = proxyToBackend;
export const HEAD = proxyToBackend;
