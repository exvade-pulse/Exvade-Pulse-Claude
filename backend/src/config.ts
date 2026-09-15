import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const config = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  port: Number(process.env.PORT ?? 3001),
  // vitest sets NODE_ENV=test automatically, so anything built via buildApp()
  // inside a test (e.g. org-isolation.test.ts) talks to the same disposable
  // database the test fixtures were inserted into, instead of DATABASE_URL.
  databaseUrl:
    (process.env.NODE_ENV === "test" ? process.env.TEST_DATABASE_URL : undefined) ??
    process.env.DATABASE_URL ??
    "",
  sessionSecret: process.env.SESSION_SECRET ?? "dev-insecure-session-secret-change-me",
  frontendUrl: process.env.FRONTEND_URL ?? "http://localhost:3000",
  allowedDomain: process.env.ALLOWED_GOOGLE_DOMAIN ?? "exvadebio.com",
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID ?? "",
    clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
    callbackUrl: process.env.GOOGLE_CALLBACK_URL ?? "http://localhost:3001/auth/google/callback",
  },
  requireDatabaseUrl(): string {
    return required("DATABASE_URL");
  },
};
