// Bun + Hono: one process per app.
import { app, port } from "./server.ts";

Bun.serve({ port, hostname: "127.0.0.1", fetch: app.fetch });
