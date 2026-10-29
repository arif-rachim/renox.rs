import { defineServices } from "renox";
import type { ModuleCtx } from "../../.renox/types/modules";

export interface User {
  id: string;
  email: string;
}

export const { currentUser, getUser } = defineServices({
  async currentUser(ctx: ModuleCtx<"auth">): Promise<User | null> {
    return ctx.db.queryOne<{ id: string; email: string }>("select id, email from auth__users limit 1");
  },
  async getUser(ctx: ModuleCtx<"auth">, id: string): Promise<User | null> {
    const days: number = ctx.config.session_days;
    void days;
    await ctx.events.emit("auth.user_registered", { user_id: id, at: 1 });
    const r = await ctx.hooks.run("auth.after_login", { user_id: id });
    void r;
    return ctx.db.queryOne<{ id: string; email: string }>("select id, email from auth__users where id = ?", [id]);
  },
});
