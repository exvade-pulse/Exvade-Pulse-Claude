import { buildApp } from "./app.js";
import { config } from "./config.js";
import { db } from "./db/client.js";
import { startGmailPoller } from "./integrations/gmailSync.js";

const app = await buildApp();

app
  .listen({ port: config.port, host: "0.0.0.0" })
  .then(() => {
    startGmailPoller(db);
  })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
