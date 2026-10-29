import { currentUser } from "./../services.js";
export async function load(ctx) { return (await currentUser(ctx)) ? Response.redirect(new URL("/", ctx.url), 303) : {}; }
export const actions = { default: async () => ({ sent: true }) };
