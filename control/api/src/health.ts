import type { Hono } from "hono";
import type { Deps, Env } from "./context.ts";

/** GET /v1/healthz: the process is up and Postgres and object storage answer. */
export function registerHealth(app: Hono<Env>, deps: Deps): void {
  app.get("/v1/healthz", async (c) => {
    c.set("action", "getHealth");
    const postgres = await deps.db.query("select 1").then(
      () => "ok" as const,
      () => "unreachable" as const,
    );
    const object_storage = await deps.store.ping().then(
      () => "ok" as const,
      () => "unreachable" as const,
    );
    const status = postgres === "ok" && object_storage === "ok" ? "ok" : "degraded";
    return c.json({ status, postgres, object_storage }, status === "ok" ? 200 : 503);
  });
}
