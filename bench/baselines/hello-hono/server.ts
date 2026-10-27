// Baseline app for BASE-HELLO (docs/14-benchmarks.md, "Baselines to compare
// against"): the same `hello` function as examples/hello, on Hono.
import { Hono } from "hono";

export const app = new Hono();

app.get("/", (c) => c.json({ ok: true }));

export const port = Number(process.env.PORT ?? "8787");
