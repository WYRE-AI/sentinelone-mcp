/**
 * Process entrypoint. Builds the Fastify app and listens. Tests import
 * `buildApp` from `./app.js` so importing this module is not required.
 */
import { buildApp, LISTEN_PORT, shutdownChildren, startIdleEviction } from "./app.js";

const app = buildApp();
startIdleEviction();

function shutdown(signal: string) {
  shutdownChildren(signal);
  app.close().finally(() => process.exit(0));
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

app.listen({ host: "0.0.0.0", port: LISTEN_PORT }).then(
  () => {
    process.stderr.write(`[s1] sentinelone-mcp wrapper listening on :${LISTEN_PORT}\n`);
  },
  (err) => {
    process.stderr.write(`[s1] failed to listen: ${err}\n`);
    process.exit(1);
  },
);
