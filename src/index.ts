/**
 * Process entrypoint. Listens via `startHttpServer`, which fail-closes when
 * CONDUIT_S2S_SECRET is missing or a known placeholder. Tests import
 * `buildApp` / `startHttpServer` from `./app.js` and do not need this module.
 */
import { shutdownChildren, startHttpServer, startIdleEviction } from "./app.js";

async function main(): Promise<void> {
  const app = await startHttpServer();
  startIdleEviction();

  const shutdown = (signal: string) => {
    shutdownChildren(signal);
    app.close().finally(() => process.exit(0));
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

// Vitest may import this module. Skip the CLI entrypoint there.
// `node dist/index.js` still starts HTTP.
if (process.env.VITEST !== "true") {
  main().catch((err: unknown) => {
    process.stderr.write(`[s1] failed to listen: ${err}\n`);
    process.exit(1);
  });
}
