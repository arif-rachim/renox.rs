// The app's Settings page (#308; deploy-api.md 0.4 section 3): the tenant
// and its erasure record through `getTenant` with the user's token. The
// dashboard never calls `deleteTenant` (the contract refuses it to every
// token); the page shows how the owner starts it and then its progress.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";

import { assertScoped, createApp_, tenant } from "../../api/tests/helpers.ts";
import { load } from "../pages/apps/[app]/settings.ts";
import { actions as signinActions } from "../pages/signin.ts";
import { actionCtx, dash, loaderCtx } from "./helpers.ts";

setDefaultTimeout(30_000);
afterEach(assertScoped);

describe("settings", () => {
  test("the tenant, no erasure, then an erasure's progress with the replica purge; deleteTenant is never sent", async () => {
    const d = await dash();
    const token = await tenant(d.h, "t_set");
    await createApp_(d.h, token, "shop");
    expect(await signinActions.default(actionCtx(d, "/signin", "default", { token, next: "/apps" }))).toBeInstanceOf(Response);
    const before = (await load(loaderCtx(d, "/apps/shop/settings", { params: { app: "shop" } }))) as Record<string, unknown>;
    expect(before.tenant).toMatchObject({ id: "t_set", state: "active" });
    expect(before.erasure).toBeNull();
    await d.h.db.query("insert into tenant_erasures (tenant_id, state, requested_at, requested_by, next_at, replica_purged_at) values ('t_set', 'erasing', $1, 'usr_x', $1, $1)", [d.h.clock.now]);
    const during = (await load(loaderCtx(d, "/apps/shop/settings", { params: { app: "shop" } }))) as Record<string, unknown>;
    expect(during.erasure).toMatchObject({ state: "erasing", completed: null, failure: null });
    expect((during.erasure as { replica_purged: string | null }).replica_purged).not.toBeNull();
    expect(d.calls.sent.some((c) => c.method === "DELETE")).toBe(false);
  });
});
