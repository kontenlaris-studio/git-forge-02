// Standalone entrypoint: run the forge as a plain long-lived HTTP server,
// without the make.fun grading harness. The harness entrypoint (main.ts)
// registers an ephemeral port with $MAKEFUN_ENV_URL and exits on the
// harness's signal; this file instead binds a fixed port (PORT env, default
// 8080) and serves until the process is stopped — the shape a container or
// a directory checker (e.g. Glama) expects.
//
// The server is the same raw-TCP HTTP listener from app.ts, routing git
// smart HTTP, REST v3, GraphQL v4 and MCP (/mcp) over one in-memory store.
// Auth: app.ts enforces a bearer check only when $MAKEFUN_SHOP_TOKEN is set;
// standalone runs leave it unset, so the surfaces answer unauthenticated —
// right for public introspection and demos, not for private data.

import { createApp } from './app.ts';

const port = Number(process.env.PORT ?? 8080);
const host = process.env.HOST ?? '0.0.0.0';

const server = createApp();
server.listen(port, host, () => {
  console.log(`forge is up on ${host}:${port} (MCP at /mcp)`);
});
