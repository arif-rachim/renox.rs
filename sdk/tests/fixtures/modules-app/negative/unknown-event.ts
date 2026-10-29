// A module emits only its own exported events.
import type { ModuleCtx } from "../.renox/types/modules";

export const emit = (ctx: ModuleCtx<"billing">) => ctx.events.emit("auth.user_registered", { user_id: "u", at: 1 });
