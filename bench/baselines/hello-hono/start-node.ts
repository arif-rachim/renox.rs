// Node + Hono (@hono/node-server): one process per app. Node runs the
// TypeScript directly (type stripping, Node >= 22.18).
import { serve } from "@hono/node-server";
import { app, port } from "./server.ts";

serve({ fetch: app.fetch, port, hostname: "127.0.0.1" });
